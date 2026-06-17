/**
 * PaymentsService.refund (BR-P06 · S5) · E2E con Postgres REAL (testcontainers) — NO se mockea la DB
 * en un crítico de dinero (CLAUDE). Reemplaza al antiguo refund.spec.ts (fake Prisma en memoria).
 *
 * S5 — reembolso REAL contra el proveedor: el camino digital llama a gateway.refund ANTES de marcar
 * éxito y `payment.refunded` (push "te devolvimos S/X") sale SOLO cuando la plata efectivamente volvió:
 *  - ACCEPTED síncrono → Refund COMPLETED + evento en la misma tx.
 *  - PENDING asíncrono → Refund PENDING (sin evento); el callback lo completa (applyRefundWebhookResult).
 *  - REJECTED → compensación de la reserva (el pago vuelve a CAPTURED) + error tipado, sin evento.
 *  - TIMEOUT/red → Refund queda PENDING (timeout ≠ falla §4), sin compensar ni evento.
 *  - Gateway sin capacidad Refundable → error tipado, sin reserva ni filas (nunca éxito falso).
 *  - CASH → devolución LOCAL (fuera del riel): COMPLETED + evento en una tx (decisión del dominio).
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import {
  ExternalServiceError,
  InvalidStateError,
  NotFoundError,
  UnprocessableEntityError,
  uuidv7,
} from '@veo/utils';
import { AdminRole } from '@veo/shared-types';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '@veo/auth';
import { PrismaClient, type PaymentMethod } from '../src/generated/prisma';
import { PaymentsService } from '../src/payments/payments.service';
import type { PrismaService } from '../src/infra/prisma.service';
import type {
  PaymentGateway,
  RefundMeta,
  RefundResult,
} from '../src/ports/gateway/payment-gateway.port';
import type { AffiliationsService } from '../src/affiliations/affiliations.service';
import type { PromotionsService } from '../src/promotions/promotions.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));
const PAX = '0192f8a0-0000-7000-8000-0000000000aa';
const RAIL_REF = 'pp_uid_original';

let db: TestDatabase;
let prisma: PrismaClient;

const noAffiliation = {
  resolveActiveWalletUid: async () => null,
} as unknown as AffiliationsService;
const noPromos = {
  redeemPromo: async () => ({ discountCents: 0 }),
} as unknown as PromotionsService;
const L2: AuthenticatedUser = {
  userId: 'op-L2',
  roles: [AdminRole.SUPPORT_L2],
} as unknown as AuthenticatedUser;

function makeConfig(): ConfigService {
  const values: Record<string, unknown> = {
    VEO_PAYMENT_MODE: 'sandbox',
    COMMISSION_RATE: 0.2,
    PAYMENT_MAX_RETRIES: 3,
    PAYMENT_RETRY_BASE_MS: 1,
    DEFAULT_PAYMENT_METHOD: 'YAPE',
    REFUND_WINDOW_DAYS: 7,
    REFUND_L2_THRESHOLD_CENTS: 3000,
    CANCELLATION_DRIVER_SHARE: 0.5,
  };
  return {
    getOrThrow: (k: string) => values[k],
    get: (k: string) => values[k],
  } as unknown as ConfigService;
}

/** Gateway doble con capacidad Refundable controlable por test (el resultado del reverso se inyecta). */
function makeService(
  refundImpl?: (ref: string, cents: number, meta?: RefundMeta) => Promise<RefundResult>,
): {
  service: PaymentsService;
  calls: { ref: string; cents: number; meta?: RefundMeta }[];
} {
  const calls: { ref: string; cents: number; meta?: RefundMeta }[] = [];
  const gateway = {
    charge: async () => ({ status: 'CONFIRMED' as const }),
    getStatement: async () => [],
    ...(refundImpl
      ? {
          refund: async (ref: string, cents: number, meta?: RefundMeta) => {
            calls.push({ ref, cents, meta });
            return refundImpl(ref, cents, meta);
          },
        }
      : {}),
  } as unknown as PaymentGateway;
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  const service = new PaymentsService(
    prismaService,
    gateway,
    noAffiliation,
    noPromos,
    makeConfig() as never,
  );
  return { service, calls };
}

/** Inserta un Payment CAPTURED reembolsable (capturedAt = ahora → dentro de la ventana). */
async function seedCaptured(
  over: { passengerId?: string | null; method?: PaymentMethod; externalRef?: string | null } = {},
): Promise<{ id: string; tripId: string }> {
  const id = uuidv7();
  const tripId = uuidv7();
  await prisma.payment.create({
    data: {
      id,
      tripId,
      passengerId: over.passengerId === undefined ? PAX : over.passengerId,
      dedupKey: `trip-completed:${tripId}`,
      amountCents: 2000,
      grossCents: 2000,
      commissionCents: 400,
      feeCents: 0,
      refundedCents: 0,
      method: over.method ?? 'YAPE',
      externalRef: over.externalRef === undefined ? RAIL_REF : over.externalRef,
      status: 'CAPTURED',
      capturedAt: new Date(),
    },
  });
  return { id, tripId };
}

async function refundedEvents(): Promise<Record<string, unknown>[]> {
  const rows = await prisma.outboxEvent.findMany({ where: { eventType: 'payment.refunded' } });
  return rows.map((r) => (r.envelope as { payload: Record<string, unknown> }).payload);
}

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'payment',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

beforeEach(async () => {
  await prisma.outboxEvent.deleteMany({});
  await prisma.refund.deleteMany({});
  await prisma.payment.deleteMany({});
});

describe('PaymentsService.refund · proveedor confirma SÍNCRONO (ACCEPTED)', () => {
  it('llama a gateway.refund con la referencia del riel y la idempotency key derivada (refund-{id})', async () => {
    const { service, calls } = makeService(async () => ({
      status: 'ACCEPTED',
      externalRefundId: 'rev-1',
    }));
    const { tripId } = await seedCaptured();

    const res = await service.refund(tripId, 500, 'cliente_insatisfecho', L2);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.ref).toBe(RAIL_REF);
    expect(calls[0]!.cents).toBe(500);
    expect(calls[0]!.meta?.idempotencyKey).toBe(`refund-${res.refundId}`);
  });

  it('reembolso parcial → payment.refunded con amountCents y passengerId enriquecido', async () => {
    const { service } = makeService(async () => ({
      status: 'ACCEPTED',
      externalRefundId: 'rev-1',
    }));
    const { id, tripId } = await seedCaptured();

    const res = await service.refund(tripId, 500, 'cliente_insatisfecho', L2);
    expect(res.status).toBe('COMPLETED');

    const p = await prisma.payment.findUnique({ where: { id } });
    expect(p?.status).toBe('PARTIALLY_REFUNDED'); // 500 de 2000 → parcial (F4)
    const [payload] = await refundedEvents();
    expect(payload).toMatchObject({
      paymentId: id,
      tripId,
      amountCents: 500, // lo reembolsado, no el bruto
      approvedBy: 'op-L2',
      passengerId: PAX,
    });
  });

  it('reembolso TOTAL → pago REFUNDED y Refund COMPLETED con el uid del reverso', async () => {
    const { service } = makeService(async () => ({
      status: 'ACCEPTED',
      externalRefundId: 'rev-9',
    }));
    const { id, tripId } = await seedCaptured();

    const res = await service.refund(tripId, 2000, 'x', L2);
    expect(res.status).toBe('COMPLETED');

    expect((await prisma.payment.findUnique({ where: { id } }))?.status).toBe('REFUNDED');
    const refunds = await prisma.refund.findMany({});
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ status: 'COMPLETED', externalRefundId: 'rev-9' });
  });

  it('sin passengerId persistido → el evento igual se emite (passengerId omitido)', async () => {
    const { service } = makeService(async () => ({ status: 'ACCEPTED' }));
    const { tripId } = await seedCaptured({ passengerId: null });
    await service.refund(tripId, 500, 'x', L2);
    const [payload] = await refundedEvents();
    expect(payload?.passengerId).toBeUndefined();
  });

  it('reembolso mayor al cobrado → InvalidStateError, sin tocar el proveedor ni emitir', async () => {
    const { service, calls } = makeService(async () => ({ status: 'ACCEPTED' }));
    const { tripId } = await seedCaptured();
    await expect(service.refund(tripId, 3000, 'x', L2)).rejects.toBeInstanceOf(InvalidStateError);
    expect(calls).toHaveLength(0);
    expect(await refundedEvents()).toHaveLength(0);
  });
});

describe('PaymentsService.refund · proveedor ASÍNCRONO (PENDING + callback)', () => {
  it('PENDING → Refund queda PENDING con el uid, SIN payment.refunded (la plata aún no volvió)', async () => {
    const { service } = makeService(async () => ({
      status: 'PENDING',
      externalRefundId: 'rev-async',
    }));
    const { id, tripId } = await seedCaptured();

    const res = await service.refund(tripId, 2000, 'x', L2);
    expect(res.status).toBe('PENDING');

    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: res.refundId } });
    expect(refund).toMatchObject({ status: 'PENDING', externalRefundId: 'rev-async' });
    // La reserva está hecha (no se puede doble-reembolsar) pero el evento/push NO salió todavía.
    expect((await prisma.payment.findUnique({ where: { id } }))?.status).toBe('REFUNDED');
    expect(await refundedEvents()).toHaveLength(0);
  });

  it('callback CONFIRMED → completa el Refund y emite payment.refunded UNA vez (redelivery idempotente)', async () => {
    const { service } = makeService(async () => ({
      status: 'PENDING',
      externalRefundId: 'rev-async',
    }));
    const { tripId } = await seedCaptured();
    const res = await service.refund(tripId, 2000, 'x', L2);

    const first = await service.applyRefundWebhookResult({
      externalRefundId: 'rev-async',
      status: 'CONFIRMED',
    });
    expect(first).toEqual({ applied: true, status: 'COMPLETED' });
    const redelivery = await service.applyRefundWebhookResult({
      externalRefundId: 'rev-async',
      status: 'CONFIRMED',
    });
    expect(redelivery).toEqual({ applied: false, status: 'COMPLETED' });

    expect((await prisma.refund.findUniqueOrThrow({ where: { id: res.refundId } })).status).toBe(
      'COMPLETED',
    );
    expect(await refundedEvents()).toHaveLength(1); // un solo push, aunque el callback se re-entregue
  });

  it('callback DECLINED → Refund REJECTED + compensación (el pago vuelve a CAPTURED), sin evento', async () => {
    const { service } = makeService(async () => ({
      status: 'PENDING',
      externalRefundId: 'rev-async',
    }));
    const { id, tripId } = await seedCaptured();
    const res = await service.refund(tripId, 2000, 'x', L2);

    const applied = await service.applyRefundWebhookResult({
      externalRefundId: 'rev-async',
      status: 'DECLINED',
    });
    expect(applied).toEqual({ applied: true, status: 'REJECTED' });

    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: res.refundId } });
    expect(refund).toMatchObject({ status: 'REJECTED', failureReason: 'reverse_declined' });
    const p = await prisma.payment.findUnique({ where: { id } });
    expect(p).toMatchObject({ status: 'CAPTURED', refundedCents: 0, refundedAt: null });
    expect(await refundedEvents()).toHaveLength(0);
  });

  it('callback sin match → NotFoundError (no-2xx: el proveedor reintenta; un 200 lo dejaría PENDING eterno)', async () => {
    const { service } = makeService(async () => ({ status: 'PENDING' }));
    await expect(
      service.applyRefundWebhookResult({ externalRefundId: 'rev-fantasma', status: 'CONFIRMED' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('CARRERA uid: callback que llega ANTES de persistir el uid → no-2xx, y el RETRY del proveedor cierra el Refund', async () => {
    // Simula el agujero real: ProntoPaga responde /reverse/new con uid y dispara el callback ANTES de
    // que refundViaGateway commitee el update del uid. La 1ra entrega DEBE fallar no-2xx (para apalancar
    // el retry del proveedor); el retry —ya con el uid persistido— completa el Refund normalmente.
    const { service } = makeService(async () => ({
      status: 'PENDING',
      externalRefundId: 'rev-carrera',
    }));
    const { tripId } = await seedCaptured();

    // 1ra entrega ANTES del refund(): el uid no existe todavía → NotFoundError (proveedor reintentará).
    await expect(
      service.applyRefundWebhookResult({ externalRefundId: 'rev-carrera', status: 'CONFIRMED' }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const res = await service.refund(tripId, 2000, 'x', L2); // persiste el uid apenas llega del gateway
    // RETRY del proveedor: ahora correlaciona y completa (payment.refunded sale UNA vez).
    const retry = await service.applyRefundWebhookResult({
      externalRefundId: 'rev-carrera',
      status: 'CONFIRMED',
    });
    expect(retry).toEqual({ applied: true, status: 'COMPLETED' });
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: res.refundId } })).status).toBe(
      'COMPLETED',
    );
    expect(await refundedEvents()).toHaveLength(1);
  });
});

describe('PaymentsService.refund · rechazo y fallas del proveedor', () => {
  it('REJECTED síncrono → compensa la reserva, Refund REJECTED y error tipado (nunca éxito falso)', async () => {
    const { service } = makeService(async () => ({ status: 'REJECTED', reason: 'monto excede' }));
    const { id, tripId } = await seedCaptured();

    await expect(service.refund(tripId, 2000, 'x', L2)).rejects.toBeInstanceOf(
      UnprocessableEntityError,
    );

    const refunds = await prisma.refund.findMany({});
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ status: 'REJECTED', failureReason: 'monto excede' });
    const p = await prisma.payment.findUnique({ where: { id } });
    expect(p).toMatchObject({ status: 'CAPTURED', refundedCents: 0 });
    expect(await refundedEvents()).toHaveLength(0);
  });

  it('TIMEOUT/red ≠ falla (§4): el Refund queda PENDING (reserva en pie), sin compensar ni emitir', async () => {
    const { service } = makeService(async () => {
      throw new ExternalServiceError('No se pudo contactar ProntoPaga: ETIMEDOUT');
    });
    const { id, tripId } = await seedCaptured();

    const res = await service.refund(tripId, 2000, 'x', L2);
    expect(res.status).toBe('PENDING');

    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: res.refundId } });
    expect(refund).toMatchObject({ status: 'PENDING', externalRefundId: null });
    expect((await prisma.payment.findUnique({ where: { id } }))?.status).toBe('REFUNDED'); // reserva en pie
    expect(await refundedEvents()).toHaveLength(0);
  });

  it('gateway SIN capacidad Refundable → error tipado, sin reserva ni filas (digital nunca se marca local)', async () => {
    const { service } = makeService(); // sin refund()
    const { id, tripId } = await seedCaptured();

    await expect(service.refund(tripId, 500, 'x', L2)).rejects.toBeInstanceOf(InvalidStateError);

    expect(await prisma.refund.findMany({})).toHaveLength(0);
    expect((await prisma.payment.findUnique({ where: { id } }))?.status).toBe('CAPTURED');
  });

  it('cobro digital SIN referencia del riel → error tipado (no hay cómo correlacionar el reverso)', async () => {
    const { service } = makeService(async () => ({ status: 'ACCEPTED' }));
    const { tripId } = await seedCaptured({ externalRef: null });
    await expect(service.refund(tripId, 500, 'x', L2)).rejects.toBeInstanceOf(InvalidStateError);
  });
});

describe('PaymentsService · compensación del reverso rechazado vs reserva CONCURRENTE (lost update)', () => {
  it('la compensación NO pisa una reserva que commitea entre medio: refundedCents = suma de refunds vivos', async () => {
    // Refund A (500) queda PENDING asíncrono (uid rev-a); Refund B (800) confirma síncrono (ACCEPTED).
    let firstCall = true;
    const { service } = makeService(async () => {
      if (firstCall) {
        firstCall = false;
        return { status: 'PENDING', externalRefundId: 'rev-a' };
      }
      return { status: 'ACCEPTED', externalRefundId: 'rev-b' };
    });
    const { id, tripId } = await seedCaptured(); // amountCents=2000
    await service.refund(tripId, 500, 'a', L2); // reserva A: refundedCents=500 (PARTIALLY_REFUNDED)

    // CARRERA REAL contra Postgres (READ COMMITTED): el callback DECLINED de A (compensa −500) corre EN
    // PARALELO con un refund nuevo de 800 (reserva CAS +800). Con el read-compute-write viejo, la
    // compensación leía refundedCents=500, computaba 0 en JS y PISABA la reserva de B commiteada entre
    // medio → refundedCents=0 con 800 ya devueltos → un refund futuro podía superar amountCents (doble
    // salida de plata). Con el decrement atómico el saldo se resta EN la DB y nada se pierde.
    const [compensation, refundB] = await Promise.allSettled([
      service.applyRefundWebhookResult({ externalRefundId: 'rev-a', status: 'DECLINED' }),
      service.refund(tripId, 800, 'b', L2),
    ]);
    expect(compensation.status).toBe('fulfilled'); // la compensación de A SIEMPRE aplica (A era PENDING)
    // B puede ganar su CAS (reserva en pie) o perderlo honesto (InvalidStateError) según el orden de
    // commit: AMBOS desenlaces son válidos. Lo INVARIABLE es la plata.
    if (refundB.status === 'rejected') {
      expect(refundB.reason).toBeInstanceOf(InvalidStateError);
    }

    const p = await prisma.payment.findUniqueOrThrow({ where: { id } });
    const aliveRefunds = await prisma.refund.findMany({ where: { status: { not: 'REJECTED' } } });
    const expectedCents = aliveRefunds.reduce((sum, r) => sum + r.amountCents, 0);
    // INVARIANTE de dinero: refundedCents == suma de refunds NO rechazados, pase lo que pase con el
    // orden de commit. Sin el decrement atómico, acá quedaba 0 con un COMPLETED de 800 vivo.
    expect(p.refundedCents).toBe(expectedCents);
    expect(p.status).toBe(expectedCents > 0 ? 'PARTIALLY_REFUNDED' : 'CAPTURED');
    expect(p.refundedAt).toBeNull(); // nunca quedó totalmente reembolsado
    // El refund A SIEMPRE termina REJECTED con la razón del proveedor.
    const rejected = await prisma.refund.findMany({ where: { status: 'REJECTED' } });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ amountCents: 500, failureReason: 'reverse_declined' });
  });
});

describe('PaymentsService.refund · CASH (devolución local, fuera del riel)', () => {
  it('CASH → COMPLETED en el acto + payment.refunded, SIN tocar el gateway', async () => {
    const { service, calls } = makeService(async () => ({ status: 'ACCEPTED' }));
    const { id, tripId } = await seedCaptured({ method: 'CASH', externalRef: null });

    const res = await service.refund(tripId, 2000, 'x', L2);
    expect(res.status).toBe('COMPLETED');

    expect(calls).toHaveLength(0); // el efectivo nunca pasó por el riel
    expect((await prisma.payment.findUnique({ where: { id } }))?.status).toBe('REFUNDED');
    expect(await refundedEvents()).toHaveLength(1);
  });
});
