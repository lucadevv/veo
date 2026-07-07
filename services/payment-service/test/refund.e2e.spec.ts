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
  ForbiddenError,
  InvalidStateError,
  NotFoundError,
  UnprocessableEntityError,
  uuidv7,
} from '@veo/utils';
import { AdminRole } from '@veo/shared-types';
import { BookingCancelledRazon } from '@veo/events';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '@veo/auth';
import { PrismaClient, type PaymentMethod } from '../src/generated/prisma';
import {
  PaymentsService,
  UNRECOVERABLE_REFUND_FAILURE_PREFIX,
} from '../src/payments/payments.service';
import { deriveBookingCancellationRefundDedupKey } from '../src/payments/payment.policy';
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
/** Operador de FINANZAS (autoridad money-OUT · refund = acción de finanzas): refunda hasta el umbral de monto
 *  alto; por ENCIMA exige elevación (ADMIN/SUPERADMIN). El nombre `L2` es legacy del gate de monto alto. */
const L2: AuthenticatedUser = {
  userId: 'op-L2',
  roles: [AdminRole.FINANCE],
} as unknown as AuthenticatedUser;
/** Operador ELEVADO (ADMIN): autoridad para reembolsos de monto alto (>umbral, dual-control BR-P06). */
const ELEVATED: AuthenticatedUser = {
  userId: 'op-admin',
  roles: [AdminRole.ADMIN],
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
    REFUND_IDEMPOTENCY_WINDOW_MINUTES: 15,
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

/** Inserta un Payment CAPTURED reembolsable (capturedAt = ahora → dentro de la ventana, salvo override). */
async function seedCaptured(
  over: {
    passengerId?: string | null;
    method?: PaymentMethod;
    externalRef?: string | null;
    capturedAt?: Date;
    amountCents?: number;
  } = {},
): Promise<{ id: string; tripId: string }> {
  const id = uuidv7();
  const tripId = uuidv7();
  const amountCents = over.amountCents ?? 2000;
  await prisma.payment.create({
    data: {
      id,
      tripId,
      passengerId: over.passengerId === undefined ? PAX : over.passengerId,
      dedupKey: `trip-completed:${tripId}`,
      amountCents,
      grossCents: amountCents,
      commissionCents: 400,
      feeCents: 0,
      refundedCents: 0,
      method: over.method ?? 'YAPE',
      externalRef: over.externalRef === undefined ? RAIL_REF : over.externalRef,
      status: 'CAPTURED',
      capturedAt: over.capturedAt ?? new Date(),
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

  it('gateway SIN capacidad Refundable → error tipado + MARCADOR DURABLE REJECTED (sin reserva: digital nunca se marca local)', async () => {
    const { service } = makeService(); // sin refund()
    const { id, tripId } = await seedCaptured();

    // Sigue lanzando el InvalidStateError tipado (no se inventa un éxito).
    await expect(service.refund(tripId, 500, 'x', L2)).rejects.toBeInstanceOf(InvalidStateError);

    // FIX 1 (invariante sagrado): aunque no haya riel por donde devolver, queda una TRAZA DURABLE — un
    // Refund REJECTED de marca con failureReason `unrecoverable:` que el admin VE en su lista de REJECTED.
    // NO es una reserva (no movió plata) → NO incrementa refundedCents y el Payment queda CAPTURED
    // (reembolsable a mano = el backstop). Una sola fila marcador, sin reserva.
    const refunds = await prisma.refund.findMany({});
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ status: 'REJECTED', amountCents: 500 });
    expect(refunds[0]?.failureReason).toContain(UNRECOVERABLE_REFUND_FAILURE_PREFIX);
    expect(refunds[0]?.failureReason).toContain('gateway-sin-reembolsos');
    const p = await prisma.payment.findUnique({ where: { id } });
    expect(p?.status).toBe('CAPTURED');
    expect(p?.refundedCents).toBe(0);
  });

  it('cobro digital SIN referencia del riel → error tipado + MARCADOR DURABLE REJECTED (no hay cómo correlacionar el reverso)', async () => {
    const { service } = makeService(async () => ({ status: 'ACCEPTED' }));
    const { tripId } = await seedCaptured({ externalRef: null });
    await expect(service.refund(tripId, 500, 'x', L2)).rejects.toBeInstanceOf(InvalidStateError);

    // FIX 1: también deja traza durable (failureReason `unrecoverable:cobro-sin-railRef`).
    const refunds = await prisma.refund.findMany({});
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ status: 'REJECTED' });
    expect(refunds[0]?.failureReason).toContain('cobro-sin-railRef');
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

/**
 * F3c FIX 1 · ÍNDICE UNIQUE PARCIAL del `Refund.dedupKey` (status <> REJECTED) verificado contra POSTGRES REAL
 * (testcontainers — el partial index NO se puede probar de verdad con un fake en memoria). LOS DOS invariantes
 * de la idempotencia financiera A LA VEZ:
 *   (a) refund REJECTED por el proveedor → el reintento del MISMO booking.cancelled CREA un Refund NUEVO y el
 *       pasajero RECIBE su plata (la barrera anti-doble-refund NO se volvió barrera anti-refund: refund-starvation
 *       cerrada). Antes, con `@unique` global, el reintento chocaba P2002 → skipped → plata NUNCA devuelta.
 *   (b) doble-refund concurrente (dos refunds VIVOS, misma dedupKey, ambos PENDING/COMPLETED) → UNO gana, el otro
 *       choca el UNIQUE parcial → skip. NO doble salida de plata.
 */
describe('PaymentsService · FIX 1 · UNIQUE PARCIAL del dedupKey (Postgres real, ambos invariantes)', () => {
  const REASON = BookingCancelledRazon.ASIENTO_LLENO;

  it('(a) REJECTED → el reintento del MISMO booking crea un Refund NUEVO y el pasajero RECIBE su plata (CASH)', async () => {
    // CASH: el camino que NO toca el gateway (devolución local). Para forzar el 1er refund a REJECTED sin
    // proveedor, lo inyectamos a mano (estado terminal-de-fallo) con la dedupKey system-initiated; luego el
    // reintento legítimo re-deriva la MISMA key y, con el índice PARCIAL, NO choca → crea un Refund nuevo.
    const { service } = makeService();
    const { id, tripId } = await seedCaptured({ method: 'CASH', externalRef: null });
    const dedupKey = deriveBookingCancellationRefundDedupKey(tripId);

    // 1er intento: el proveedor rechazó → Refund REJECTED con la dedupKey (la plata NO volvió, el Payment sigue
    // CAPTURED/reembolsable). Simula el resultado de rejectRefundAndCompensate por el path webhook.
    await prisma.refund.create({
      data: {
        id: uuidv7(),
        paymentId: id,
        amountCents: 2000,
        requestedBy: 'system',
        approvedBy: 'system',
        dedupKey,
        status: 'REJECTED',
        reason: REASON,
        failureReason: 'reverse_declined',
      },
    });

    // Reintento del MISMO booking.cancelled: re-deriva la MISMA dedupKey. Con el UNIQUE PARCIAL el REJECTED no
    // bloquea → se crea un Refund NUEVO y (CASH local) sale COMPLETED → la plata SÍ vuelve.
    const res = await service.refundForBookingCancellation(tripId, REASON);
    expect('skipped' in res).toBe(false);
    if ('skipped' in res) throw new Error('el reintento NO debía saltarse: el pasajero quedaría sin plata');
    expect(res.status).toBe('COMPLETED');

    // Quedan 2 Refunds con la MISMA dedupKey: el REJECTED viejo + el COMPLETED nuevo (coexisten porque el UNIQUE
    // es parcial). El pasajero recibió su plata UNA vez (el nuevo) y el Payment quedó REFUNDED.
    const refunds = await prisma.refund.findMany({ where: { dedupKey }, orderBy: { status: 'asc' } });
    expect(refunds.map((r) => r.status).sort()).toEqual(['COMPLETED', 'REJECTED']);
    expect((await prisma.payment.findUnique({ where: { id } }))?.status).toBe('REFUNDED');
    const [payload] = await refundedEvents();
    expect(payload).toMatchObject({ paymentId: id, amountCents: 2000 });
  });

  it('(b) doble-refund concurrente (dos VIVOS, misma key) → UNO gana, el otro choca el UNIQUE parcial → no doble plata', async () => {
    // Inserción DIRECTA y concurrente de dos Refunds con la MISMA dedupKey y status VIVO (PENDING): el índice
    // parcial DEBE dejar pasar solo a uno. Esto prueba el invariante anti-doble-refund a nivel de la DB real.
    const { id, tripId } = await seedCaptured();
    const dedupKey = deriveBookingCancellationRefundDedupKey(tripId);
    const mkRefund = (status: 'PENDING' | 'COMPLETED') =>
      prisma.refund.create({
        data: {
          id: uuidv7(),
          paymentId: id,
          amountCents: 2000,
          requestedBy: 'system',
          approvedBy: 'system',
          dedupKey,
          status,
          reason: REASON,
        },
      });

    const [first, second] = await Promise.allSettled([mkRefund('PENDING'), mkRefund('PENDING')]);
    const fulfilled = [first, second].filter((r) => r.status === 'fulfilled');
    const rejected = [first, second].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1); // exactamente UN refund vivo con esa key
    expect(rejected).toHaveLength(1); // el otro chocó el UNIQUE parcial (P2002)

    const vivos = await prisma.refund.count({ where: { dedupKey, status: { not: 'REJECTED' } } });
    expect(vivos).toBe(1); // INVARIANTE: nunca dos refunds VIVOS con la misma key (no doble plata)

    // Y un COMPLETED tampoco admite un 2do vivo (la barrera vale para todo estado no-REJECTED).
    await expect(mkRefund('COMPLETED')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('(c) coexisten MÚLTIPLES REJECTED con la misma key (reintentos sucesivos del proveedor) sin chocar', async () => {
    // Cada reintento fallido deja un Refund REJECTED con la MISMA key; el índice parcial los EXCLUYE a todos,
    // así que conviven (es lo que el re-conductor cuenta para acotar los reintentos). NINGÚN choque P2002.
    const { id, tripId } = await seedCaptured({ method: 'CASH', externalRef: null });
    const dedupKey = deriveBookingCancellationRefundDedupKey(tripId);
    for (let i = 0; i < 3; i++) {
      await prisma.refund.create({
        data: {
          id: uuidv7(),
          paymentId: id,
          amountCents: 2000,
          requestedBy: 'system',
          approvedBy: 'system',
          dedupKey,
          status: 'REJECTED',
          reason: REASON,
          failureReason: 'reverse_declined',
        },
      });
    }
    expect(await prisma.refund.count({ where: { dedupKey, status: 'REJECTED' } })).toBe(3);
  });
});

/**
 * F3c FIX 3 · BLINDAJE de regresión del REFUND ADMIN (BR-P06). El refactor extrajo `executeRefundClaim` y
 * reshapeó `RefundClaim` (operator → {requestedBy, approvedBy, dedupKey}); este spec VERIFICA (no asume) que el
 * camino admin CONSERVA sus gates: gate de monto alto (>umbral exige autoridad ELEVADA ADMIN/SUPERADMIN · dual-control), ventana de 7 días, RBAC — y que el
 * system-initiated NO los tiene (diferencia DELIBERADA: refund OBLIGATORIO, sin discrecionalidad que limitar).
 */
describe('PaymentsService.refund · FIX 3 · gates del refund ADMIN (regresión BR-P06)', () => {
  it('gate monto alto: FINANCE refundando >umbral SIN ser ADMIN/SUPERADMIN → ForbiddenError, sin tocar el proveedor', async () => {
    const { service, calls } = makeService(async () => ({ status: 'ACCEPTED' }));
    const { id, tripId } = await seedCaptured({ amountCents: 5000 }); // S/50, > umbral (3000)

    // FINANCE puede reembolsar, pero un monto ALTO (>umbral) exige autoridad elevada → bloqueado (dual-control).
    await expect(service.refund(tripId, 4000, 'x', L2)).rejects.toBeInstanceOf(ForbiddenError);
    expect(calls).toHaveLength(0); // NO se intentó el reverso
    expect((await prisma.payment.findUnique({ where: { id } }))?.status).toBe('CAPTURED');
    expect(await prisma.refund.findMany({})).toHaveLength(0);
  });

  it('gate monto alto: operador ELEVADO (ADMIN) refundando >umbral → procede', async () => {
    const { service } = makeService(async () => ({ status: 'ACCEPTED', externalRefundId: 'rev' }));
    const { tripId } = await seedCaptured({ amountCents: 5000 });
    const res = await service.refund(tripId, 4000, 'x', ELEVATED);
    expect(res.status).toBe('COMPLETED');
  });

  it('gate monto alto: FINANCE refundando ≤umbral → procede (el monto bajo NO exige elevación)', async () => {
    const { service } = makeService(async () => ({ status: 'ACCEPTED', externalRefundId: 'rev' }));
    const { tripId } = await seedCaptured({ amountCents: 5000 });
    const res = await service.refund(tripId, 3000, 'x', L2); // exactamente el umbral, no lo supera
    expect(res.status).toBe('COMPLETED');
  });

  it('ventana 7d: cobro capturado hace 8 días → InvalidStateError, sin proveedor ni filas', async () => {
    const { service, calls } = makeService(async () => ({ status: 'ACCEPTED' }));
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
    const { id, tripId } = await seedCaptured({ capturedAt: eightDaysAgo });

    await expect(service.refund(tripId, 500, 'x', L2)).rejects.toBeInstanceOf(InvalidStateError);
    expect(calls).toHaveLength(0);
    expect(await prisma.refund.findMany({})).toHaveLength(0);
    expect((await prisma.payment.findUnique({ where: { id } }))?.status).toBe('CAPTURED');
  });

  it('ventana 7d: cobro capturado hace 6 días → procede (dentro de la ventana)', async () => {
    const { service } = makeService(async () => ({ status: 'ACCEPTED', externalRefundId: 'rev' }));
    const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000);
    const { tripId } = await seedCaptured({ capturedAt: sixDaysAgo });
    const res = await service.refund(tripId, 500, 'x', L2);
    expect(res.status).toBe('COMPLETED');
  });

  it('DIFERENCIA DELIBERADA: el system-initiated NO tiene gate L2 ni ventana (refund OBLIGATORIO)', async () => {
    // Monto alto (>S/30) Y fuera de la ventana de 7 días: para el ADMIN serían DOS rechazos. El system-initiated
    // (refundForBookingCancellation) los IGNORA — el pasajero pagó y no viajó → se le devuelve SIEMPRE.
    const { service } = makeService(async () => ({ status: 'ACCEPTED', externalRefundId: 'rev-sys' }));
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    const { id, tripId } = await seedCaptured({ amountCents: 8000, capturedAt: tenDaysAgo });

    const res = await service.refundForBookingCancellation(tripId, BookingCancelledRazon.ASIENTO_LLENO);
    expect('skipped' in res).toBe(false);
    if ('skipped' in res) throw new Error('el refund OBLIGATORIO no debía saltarse');
    expect(res.status).toBe('COMPLETED');
    expect((await prisma.payment.findUnique({ where: { id } }))?.status).toBe('REFUNDED');
  });
});

/**
 * BACKSTOP SERVER-SIDE de idempotencia por VENTANA TEMPORAL (decisión del dueño · cierre DURO del residual del
 * nonce de cliente). El `Idempotency-Key` del browser es best-effort: puede DIVERGIR (storage bloqueado, otra
 * pestaña, otro dispositivo). El server cierra el hueco tratando dos reembolsos del MISMO (paymentId, céntimos)
 * dentro de la ventana como la MISMA operación —INDEPENDIENTE del key— salvo el gesto explícito `forceNew`.
 * Verifica contra Postgres real (advisory lock + createdAt + saldo), no contra un doble.
 */
describe('PaymentsService.refund · backstop de VENTANA de idempotencia (cross-key)', () => {
  it('keys DISTINTOS, mismo (pago, monto), SIN forceNew → el 2do devuelve el existente (NO doble-paga)', async () => {
    const { service } = makeService(async () => ({ status: 'ACCEPTED', externalRefundId: 'rev' }));
    const { id, tripId } = await seedCaptured({ amountCents: 5000, method: 'CASH' });

    const a = await service.refund(tripId, 1500, 'x', L2, 'KEY-A');
    // 2do intento con un key DIVERGENTE (el nonce de cliente se re-acuñó: storage caído / otra pestaña / device):
    const b = await service.refund(tripId, 1500, 'x', L2, 'KEY-B');

    expect(b.refundId).toBe(a.refundId); // el backstop devolvió el existente
    expect(await prisma.refund.findMany({ where: { paymentId: id } })).toHaveLength(1); // un solo money-OUT
    expect((await prisma.payment.findUnique({ where: { id } }))?.refundedCents).toBe(1500);
  });

  it('keys DISTINTOS, mismo (pago, monto), CON forceNew → DOS refunds (parcial idéntico deliberado)', async () => {
    const { service } = makeService(async () => ({ status: 'ACCEPTED', externalRefundId: 'rev' }));
    const { id, tripId } = await seedCaptured({ amountCents: 5000, method: 'CASH' });

    await service.refund(tripId, 1500, 'x', L2, 'KEY-A');
    await service.refund(tripId, 1500, 'x', L2, 'KEY-B', true); // gesto explícito: es un reembolso NUEVO

    expect(await prisma.refund.findMany({ where: { paymentId: id } })).toHaveLength(2);
    expect((await prisma.payment.findUnique({ where: { id } }))?.refundedCents).toBe(3000);
  });

  it('SIN key en ambos (idempotencia opt-in apagada) → la VENTANA igual dedupea por identidad de dinero', async () => {
    // El backstop NO depende del key: aun sin Idempotency-Key, dos reembolsos del mismo (pago, monto) en la
    // ventana colapsan (cierra el viejo hueco "sin key ⇒ solo CAS, que no es idempotente").
    const { service } = makeService(async () => ({ status: 'ACCEPTED', externalRefundId: 'rev' }));
    const { id, tripId } = await seedCaptured({ amountCents: 5000, method: 'CASH' });

    const a = await service.refund(tripId, 1200, 'x', L2);
    const b = await service.refund(tripId, 1200, 'x', L2);

    expect(b.refundId).toBe(a.refundId);
    expect((await prisma.payment.findUnique({ where: { id } }))?.refundedCents).toBe(1200);
  });

  it('CONCURRENTE (TOCTOU): dos refunds SIMULTÁNEOS, keys distintos, mismo (pago, monto) → el advisory lock serializa → UN solo money-OUT', async () => {
    // La razón de existir del pg_advisory_xact_lock: SIN él, dos submits simultáneos con keys DIVERGENTES pasan
    // ambos el findFirst (ninguno commiteó aún) → DOS refunds = doble-pago. CON el lock, el 2do espera al 1ro, ve
    // el refund recién creado dentro de la ventana y dedupea. Este test ejercita esa carrera (Promise.all), no
    // un await secuencial (donde el 1ro ya commiteó).
    const { service } = makeService(async () => ({ status: 'ACCEPTED', externalRefundId: 'rev' }));
    const { id, tripId } = await seedCaptured({ amountCents: 5000, method: 'CASH' });

    const [a, b] = await Promise.all([
      service.refund(tripId, 1500, 'x', L2, 'KEY-A'),
      service.refund(tripId, 1500, 'x', L2, 'KEY-B'), // key DIVERGENTE, concurrente
    ]);

    expect(a.refundId).toBe(b.refundId); // ambos resuelven al MISMO refund (uno creó, el otro dedupeó)
    expect(await prisma.refund.findMany({ where: { paymentId: id } })).toHaveLength(1); // un solo money-OUT
    expect((await prisma.payment.findUnique({ where: { id } }))?.refundedCents).toBe(1500);
  });
});

describe('PaymentsService.getPaymentByTrip · hueco #2 (lookup del cobro reembolsable)', () => {
  /** Inserta un Payment del viaje con kind/status/captura controlados (el resto = defaults conocidos-buenos). */
  async function seedPayment(o: {
    tripId: string;
    kind: 'FARE' | 'TIP';
    status?: 'CAPTURED' | 'PENDING';
    capturedAt?: Date;
    amountCents?: number;
  }): Promise<string> {
    const id = uuidv7();
    const amountCents = o.amountCents ?? 2000;
    const status = o.status ?? 'CAPTURED';
    await prisma.payment.create({
      data: {
        id,
        tripId: o.tripId,
        passengerId: PAX,
        dedupKey: `${o.kind.toLowerCase()}:${id}`,
        amountCents,
        grossCents: amountCents,
        commissionCents: 400,
        feeCents: 0,
        refundedCents: 0,
        method: 'YAPE',
        kind: o.kind,
        status,
        capturedAt: status === 'PENDING' ? null : (o.capturedAt ?? new Date()),
      },
    });
    return id;
  }

  it('devuelve el cobro FARE del viaje, NUNCA el TIP del mismo trip (A1 · ADR-022)', async () => {
    const { service } = makeService();
    const tripId = uuidv7();
    await seedPayment({ tripId, kind: 'TIP' }); // propina del mismo viaje — NO elegible para reembolso
    const fareId = await seedPayment({ tripId, kind: 'FARE' });

    const payment = await service.getPaymentByTrip(tripId);
    expect(payment.id).toBe(fareId);
    expect(payment.kind).toBe('FARE');
  });

  it('elige el FARE reembolsable MÁS RECIENTE (orderBy capturedAt desc)', async () => {
    const { service } = makeService();
    const tripId = uuidv7();
    await seedPayment({ tripId, kind: 'FARE', capturedAt: new Date(Date.now() - 3_600_000) });
    const newer = await seedPayment({ tripId, kind: 'FARE', capturedAt: new Date() });

    expect((await service.getPaymentByTrip(tripId)).id).toBe(newer);
  });

  it('sin cobro reembolsable para el viaje → NotFoundError (mismo desenlace que refund)', async () => {
    const { service } = makeService();
    await expect(service.getPaymentByTrip(uuidv7())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('un cobro PENDING (no capturado) NO es reembolsable → NotFoundError', async () => {
    const { service } = makeService();
    const tripId = uuidv7();
    await seedPayment({ tripId, kind: 'FARE', status: 'PENDING' });
    await expect(service.getPaymentByTrip(tripId)).rejects.toBeInstanceOf(NotFoundError);
  });
});
