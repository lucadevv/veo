/**
 * RC18 (ADR-022) · Clawback CONDICIONAL del neto del conductor en un refund TOTAL de tarifa digital · E2E con
 * Postgres REAL (testcontainers) — NO se mockea la DB en un crítico de dinero (CLAUDE).
 *
 * El bug: un refund digital de un viaje YA liquidado no recuperaba nada (el enum de deuda solo tenía
 * CASH_COMMISSION y refundViaGateway no tocaba DriverDebt) → la plataforma comía el neto ya pagado al conductor
 * de un viaje revertido. Decisión de producto (clawback CONDICIONAL): solo si el refund es por causa atribuible
 * al conductor (driverFault). Un dispute/fraude del PASAJERO lo absorbe la plataforma (no castigar al conductor).
 *
 * Verifica contra DB real: la DriverDebt REFUND_CLAWBACK nace SOLO cuando (driverFault ∧ total ∧ digital ∧ FARE ∧
 * conductor ∧ ya liquidado); y NO nace cuando falta cualquiera de esas condiciones (el peor error sería cobrarle
 * al conductor un viaje que aún no cobró, o uno reembolsado por culpa del pasajero).
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { uuidv7 } from '@veo/utils';
import { AdminRole } from '@veo/shared-types';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '@veo/auth';
import { PrismaClient } from '../src/generated/prisma';
import { PaymentsService } from '../src/payments/payments.service';
import { PaymentsRepository } from '../src/payments/payments.repository';
import type { PrismaService } from '../src/infra/prisma.service';
import type { PaymentGateway } from '../src/ports/gateway/payment-gateway.port';
import type { AffiliationsService } from '../src/affiliations/affiliations.service';
import type { PromotionsService } from '../src/promotions/promotions.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));
const PAX = '0192f8a0-0000-7000-8000-0000000000aa';
const DRIVER = '0192f8a0-0000-7000-8000-0000000000dd';
const RAIL_REF = 'pp_uid_clawback';

// Ventana de liquidación: el viaje se captura DENTRO, y (para "ya liquidado") existe un Payout de ese período.
const CAPTURED_AT = new Date('2026-05-20T12:00:00.000Z');
const PERIOD_START = new Date('2026-05-18T00:00:00.000Z');
const PERIOD_END = new Date('2026-05-25T00:00:00.000Z');

let db: TestDatabase;
let prisma: PrismaClient;

const noAffiliation = { resolveActiveWalletUid: async () => null } as unknown as AffiliationsService;
const noPromos = { redeemPromo: async () => ({ discountCents: 0 }) } as unknown as PromotionsService;
const FINANCE: AuthenticatedUser = {
  userId: 'op-finance',
  roles: [AdminRole.FINANCE],
} as unknown as AuthenticatedUser;
// Segregación de funciones (four-eyes · money-OUT): quien SOLICITA no puede APROBAR. El requester lleva otro userId.
const REQUESTER: AuthenticatedUser = {
  userId: 'op-requester',
  roles: [AdminRole.FINANCE],
} as unknown as AuthenticatedUser;

function makeConfig(): ConfigService {
  const values: Record<string, unknown> = {
    VEO_PAYMENT_MODE: 'sandbox',
    COMMISSION_RATE: 0.2,
    PAYMENT_MAX_RETRIES: 3,
    PAYMENT_RETRY_BASE_MS: 1,
    DEFAULT_PAYMENT_METHOD: 'YAPE',
    REFUND_WINDOW_DAYS: 3650, // ventana amplia: el viaje es de mayo, el "ahora" del test es posterior
    REFUND_L2_THRESHOLD_CENTS: 100_000,
    REFUND_IDEMPOTENCY_WINDOW_MINUTES: 15,
    CANCELLATION_DRIVER_SHARE: 0.5,
  };
  return {
    getOrThrow: (k: string) => values[k],
    get: (k: string) => values[k],
  } as unknown as ConfigService;
}

/** Gateway que confirma el reverso SÍNCRONO (ACCEPTED) → completeRefund corre y evalúa el clawback. */
function makeService(): PaymentsService {
  const gateway = {
    charge: async () => ({ status: 'CONFIRMED' as const }),
    getStatement: async () => [],
    refund: async () => ({ status: 'ACCEPTED' as const, externalRefundId: 'rev-clawback' }),
  } as unknown as PaymentGateway;
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  return new PaymentsService(
    new PaymentsRepository(prismaService),
    gateway,
    noAffiliation,
    noPromos,
    makeConfig() as never,
  );
}

/**
 * Reembolso ADMIN de punta a punta con develop's multi-phase API (la de un solo paso `refund()` ya no existe):
 * `requestRefund` crea la solicitud PENDING y cristaliza `driverFault→clawbackDriver`; `approveRefund` DESEMBOLSA
 * (reverso ACCEPTED sync → `completeRefund` → `applyRefundClawbackInTx`). Four-eyes: solicita REQUESTER, aprueba
 * FINANCE (distinto userId). Monto < REFUND_L2_THRESHOLD → FINANCE puede aprobar sin autoridad elevada.
 */
async function refund(
  service: PaymentsService,
  tripId: string,
  amountCents: number,
  reason: string,
  driverFault: boolean,
): Promise<{ refundId: string; paymentId: string; status: string }> {
  const req = await service.requestRefund(
    tripId,
    amountCents,
    reason,
    REQUESTER,
    undefined,
    false,
    driverFault,
  );
  return service.approveRefund(req.refundId, FINANCE);
}

/** Cobro DIGITAL FARE CAPTURED de un conductor: gross 2000 − comisión 400 = neto 1600. */
async function seedCapturedFare(over: { method?: 'YAPE' | 'CASH'; driverId?: string | null } = {}) {
  const id = uuidv7();
  const tripId = uuidv7();
  await prisma.payment.create({
    data: {
      id,
      tripId,
      passengerId: PAX,
      driverId: over.driverId === undefined ? DRIVER : over.driverId,
      dedupKey: `trip-completed:${tripId}`,
      amountCents: 2000,
      grossCents: 2000,
      commissionCents: 400,
      feeCents: 0,
      refundedCents: 0,
      method: over.method ?? 'YAPE',
      externalRef: RAIL_REF,
      status: 'CAPTURED',
      kind: 'FARE',
      capturedAt: CAPTURED_AT,
    },
  });
  return { id, tripId };
}

/** Marca que el conductor YA fue liquidado por el período que cubre el capturedAt (un Payout de ese período). */
async function seedPayoutForPeriod(driverId: string): Promise<void> {
  await prisma.payout.create({
    data: {
      id: uuidv7(),
      driverId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      grossCents: 2000,
      commissionCents: 400,
      amountCents: 1600,
      status: 'PROCESSED',
    },
  });
}

async function clawbackDebts(driverId: string) {
  return prisma.driverDebt.findMany({ where: { driverId, reason: 'REFUND_CLAWBACK' } });
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
  await prisma.driverDebt.deleteMany({});
  await prisma.refund.deleteMany({});
  await prisma.payout.deleteMany({});
  await prisma.payment.deleteMany({});
});

describe('RC18 · clawback del neto del conductor en refund TOTAL por su causa', () => {
  it('driverFault=true + refund TOTAL + ya liquidado → DriverDebt REFUND_CLAWBACK PENDING por el neto (gross−comisión)', async () => {
    const { tripId } = await seedCapturedFare();
    await seedPayoutForPeriod(DRIVER);

    const res = await refund(makeService(), tripId, 2000, 'viaje_no_realizado', true);
    expect(res.status).toBe('COMPLETED');

    const debts = await clawbackDebts(DRIVER);
    expect(debts).toHaveLength(1);
    expect(debts[0]!.amountCents).toBe(1600); // 2000 bruto − 400 comisión = neto que el conductor cobró
    expect(debts[0]!.status).toBe('PENDING'); // se netea del próximo payout (applyDebtNetting)
  });

  it('driverFault=FALSE (dispute del pasajero) + refund TOTAL + ya liquidado → NINGUNA deuda (la plataforma lo absorbe)', async () => {
    const { tripId } = await seedCapturedFare();
    await seedPayoutForPeriod(DRIVER);

    await refund(makeService(), tripId, 2000, 'pasajero_disconforme', false);

    expect(await clawbackDebts(DRIVER)).toHaveLength(0); // no se castiga al conductor por un dispute que no controló
  });

  it('driverFault=true pero AÚN NO liquidado (sin Payout del período) → NINGUNA deuda (el sweep ya excluye el REFUNDED)', async () => {
    const { tripId } = await seedCapturedFare(); // sin seedPayout → el conductor todavía no cobró este viaje

    await refund(makeService(), tripId, 2000, 'viaje_no_realizado', true);

    // Crear la deuda acá sería doble-castigo: el viaje quedó REFUNDED → collectEarnings ya no lo paga.
    expect(await clawbackDebts(DRIVER)).toHaveLength(0);
  });

  it('driverFault=true pero refund PARCIAL → NINGUNA deuda (el parcial lo absorbe la plataforma de su comisión)', async () => {
    const { tripId } = await seedCapturedFare();
    await seedPayoutForPeriod(DRIVER);

    await refund(makeService(), tripId, 500, 'ajuste_parcial', true); // 500 de 2000

    expect(await clawbackDebts(DRIVER)).toHaveLength(0); // solo el refund TOTAL clawbackea
  });

  it('idempotencia: la DriverDebt lleva UNIQUE(paymentId) → un solo clawback por pago (no se duplica)', async () => {
    const { id, tripId } = await seedCapturedFare();
    await seedPayoutForPeriod(DRIVER);

    await refund(makeService(), tripId, 2000, 'viaje_no_realizado', true);
    const debts = await clawbackDebts(DRIVER);
    expect(debts).toHaveLength(1);
    expect(debts[0]!.paymentId).toBe(id); // ligada al pago; el UNIQUE impide un 2do clawback del mismo pago
  });
});
