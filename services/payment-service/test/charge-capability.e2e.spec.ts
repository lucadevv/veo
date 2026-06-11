/**
 * Clasificación HONESTA del fallo de COBRO por CAPACIDAD · E2E con Postgres REAL (testcontainers) — NO
 * se mockea la DB en un crítico de dinero (CLAUDE). Reemplaza al antiguo charge-capability.spec.ts.
 *
 * Cuando el método NO está habilitado en el comercio, el adapter devuelve un DECLINE TIPADO
 * (failureKind=capability_unavailable) y el Payment cae a DEBT con `method_unavailable:<METHOD>` (no
 * genérico), para que la app diga "ese método no está disponible, elegí otro". El gateway se inyecta
 * (stub de resultado fijo); la DB es real.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, runPrismaMigrateDeploy, type TestDatabase } from '@veo/database/testing';
import { uuidv7 } from '@veo/utils';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../src/generated/prisma';
import { PaymentsService } from '../src/payments/payments.service';
import type {
  PaymentGateway,
  GatewayChargeRequest,
  GatewayChargeResult,
} from '../src/ports/gateway/payment-gateway.port';
import type { PrismaService } from '../src/infra/prisma.service';
import type { AffiliationsService } from '../src/affiliations/affiliations.service';
import type { PromotionsService } from '../src/promotions/promotions.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));
const PAX = '0192f8a0-0000-7000-8000-0000000000aa';

let db: TestDatabase;
let prisma: PrismaClient;

const noPromos = { redeemPromo: async () => ({ discountCents: 0 }) } as unknown as PromotionsService;
const noAffiliation = { resolveActiveWalletUid: async () => null } as unknown as AffiliationsService;

function makeConfig(): ConfigService {
  const values: Record<string, unknown> = {
    COMMISSION_RATE: 0.2,
    PAYMENT_MAX_RETRIES: 3,
    PAYMENT_RETRY_BASE_MS: 1,
    DEFAULT_PAYMENT_METHOD: 'YAPE',
    REFUND_WINDOW_DAYS: 7,
    REFUND_L2_THRESHOLD_CENTS: 3000,
    CANCELLATION_DRIVER_SHARE: 0.5,
  };
  return { getOrThrow: (k: string) => values[k], get: (k: string) => values[k] } as unknown as ConfigService;
}

/**
 * Gateway que devuelve un result fijo en charge (clasificación inyectada por test). Declara sus
 * capacidades como exige el contrato BASE del puerto (chargeFlow + supports): el service despacha
 * según lo que el adapter DECLARA (acá: agregador con catálogo total — la deshabilitación COMERCIAL
 * se clasifica en runtime vía failureKind, que es exactamente lo que prueban estos tests).
 */
function fixedGateway(result: GatewayChargeResult): PaymentGateway {
  return {
    chargeFlow: 'aggregator',
    supports: () => true,
    charge: async (_req: GatewayChargeRequest) => result,
    getStatement: async () => [],
  } satisfies PaymentGateway;
}

function makeService(gateway: PaymentGateway): PaymentsService {
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  return new PaymentsService(prismaService, gateway, noAffiliation, noPromos, makeConfig() as never);
}

async function seedDebt(over: { method?: string; failureReason?: string | null } = {}): Promise<{ id: string }> {
  const id = uuidv7();
  const tripId = uuidv7();
  await prisma.payment.create({
    data: {
      id,
      tripId,
      passengerId: PAX,
      dedupKey: `trip-completed:${tripId}`,
      amountCents: 2300,
      grossCents: 2000,
      commissionCents: 400,
      feeCents: 0,
      method: (over.method ?? 'PAGOEFECTIVO') as never,
      status: 'DEBT',
      failureReason: over.failureReason === undefined ? null : over.failureReason,
    },
  });
  return { id };
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
  await prisma.payment.deleteMany({});
});

describe('cobro · clasificación honesta del fallo por capacidad', () => {
  it('changeMethod a un método NO habilitado → DEBT con failureReason method_unavailable:<METHOD>', async () => {
    const { id } = await seedDebt({ method: 'YAPE', failureReason: 'yape_insufficient_funds' });
    const svc = makeService(fixedGateway({ status: 'DECLINED', failureKind: 'capability_unavailable', reason: 'not enabled' }));
    const out = await svc.changeMethod(id, 'PAGOEFECTIVO');
    expect(out.status).toBe('DEBT');
    expect(out.failureReason).toBe('method_unavailable:PAGOEFECTIVO'); // estructurada por-método
  });

  it('decline NORMAL (sin failureKind) → DEBT con el reason del riel, NO method_unavailable', async () => {
    const { id } = await seedDebt({ method: 'YAPE', failureReason: null });
    const svc = makeService(fixedGateway({ status: 'DECLINED', reason: 'declined' }));
    const out = await svc.changeMethod(id, 'PLIN');
    expect(out.status).toBe('DEBT');
    expect(out.failureReason).toBe('declined');
    expect(out.failureReason).not.toMatch(/method_unavailable/);
  });

  it('retryCharge sobre un método no habilitado → DEBT method_unavailable:<METHOD> (no loop ciego)', async () => {
    const { id } = await seedDebt({ method: 'PAGOEFECTIVO', failureReason: 'method_unavailable:PAGOEFECTIVO' });
    const svc = makeService(fixedGateway({ status: 'DECLINED', failureKind: 'capability_unavailable', reason: 'not enabled' }));
    const out = await svc.retryCharge(id);
    expect(out.status).toBe('DEBT');
    expect(out.failureReason).toBe('method_unavailable:PAGOEFECTIVO');
  });
});
