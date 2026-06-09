/**
 * E2E ProntoPaga · PENDING_EXTERNAL → webhook → CAPTURED · Postgres REAL (testcontainers) — NO se
 * mockea la DB en un crítico de dinero (CLAUDE). Reemplaza al antiguo src/webhooks/prontopaga-webhook
 * .e2e.spec.ts (fake Prisma en memoria, mal etiquetado e2e).
 *
 * Usa el adapter SANDBOX en modo pendingExternal (mismo firmador/contrato que ProntoPaga): prueba la
 * idempotencia del webhook, las transiciones de estado, el 401 por firma inválida y el tope on-file.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, runPrismaMigrateDeploy, type TestDatabase } from '@veo/database/testing';
import { UnauthorizedError } from '@veo/utils';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../src/generated/prisma';
import { PaymentsService } from '../src/payments/payments.service';
import { ProntoPagaWebhookService } from '../src/webhooks/prontopaga-webhook.service';
import { SandboxPaymentGateway } from '../src/ports/gateway/sandbox.gateway';
import type { PrismaService } from '../src/infra/prisma.service';
import type { AffiliationsService } from '../src/affiliations/affiliations.service';
import type { PromotionsService } from '../src/promotions/promotions.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'dev-sandbox-webhook-secret';
const PAX = '0192f8a0-0000-7000-8000-0000000000aa';

let db: TestDatabase;
let prisma: PrismaClient;
let prismaService: PrismaService;
let gateway: SandboxPaymentGateway;
let payments: PaymentsService;
let webhook: ProntoPagaWebhookService;

const noPromos = { redeemPromo: async () => ({ discountCents: 0 }) } as unknown as PromotionsService;
const noAffiliation = { resolveActiveWalletUid: async () => null } as unknown as AffiliationsService;

function makeConfig(): ConfigService {
  const values: Record<string, unknown> = {
    VEO_PAYMENT_MODE: 'prontopaga',
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

function chargeYape() {
  return payments.charge({
    tripId: '0192f8a0-0000-7000-8000-000000000001',
    grossCents: 2000,
    method: 'YAPE',
    dedupKey: 'trip-1',
    userId: PAX,
  });
}

async function findPayment(id: string) {
  return prisma.payment.findUniqueOrThrow({ where: { id } });
}
async function capturedEvents() {
  return prisma.outboxEvent.findMany({ where: { eventType: 'payment.captured' } });
}

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'payment',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
  prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  gateway = new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000', pendingExternal: true, webhookSecret: SECRET });
  payments = new PaymentsService(prismaService, gateway, noAffiliation, noPromos, makeConfig() as never);
  webhook = new ProntoPagaWebhookService(gateway, payments, noAffiliation);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

beforeEach(async () => {
  await prisma.outboxEvent.deleteMany({});
  await prisma.payment.deleteMany({});
});

describe('E2E ProntoPaga · PENDING_EXTERNAL → webhook → CAPTURED', () => {
  it('charge deja el pago PENDING con checkout persistido (qr/uid)', async () => {
    const p = await chargeYape();
    expect(p.status).toBe('PENDING');
    expect(p.externalUid).toBeTruthy();
    expect(p.qrCode).toContain('data:image/png;base64,');
  });

  it('webhook success FIRMADO → CAPTURED + payment.captured en outbox', async () => {
    const p = await chargeYape();
    const { body } = gateway.buildSignedWebhook({ uid: p.externalUid as string, order: p.id, status: 'success' });
    await webhook.process(body, {});

    expect((await findPayment(p.id)).status).toBe('CAPTURED');
    expect(await capturedEvents()).toHaveLength(1);
  });

  it('webhook IDEMPOTENTE: re-entregar el mismo success no recaptura ni duplica el evento', async () => {
    const p = await chargeYape();
    const { body } = gateway.buildSignedWebhook({ uid: p.externalUid as string, order: p.id, status: 'success' });
    await webhook.process(body, {});
    await webhook.process(body, {});

    expect(await capturedEvents()).toHaveLength(1); // una sola captura
  });

  it('firma inválida → UnauthorizedError (401), el pago NO cambia', async () => {
    const p = await chargeYape();
    const bad = JSON.stringify({ uid: p.externalUid, order: p.id, status: 'success', sign: 'firma-mala' });
    await expect(webhook.process(bad, {})).rejects.toBeInstanceOf(UnauthorizedError);
    expect((await findPayment(p.id)).status).toBe('PENDING');
  });

  it('webhook expired → FAILED reason expired', async () => {
    const p = await chargeYape();
    const { body } = gateway.buildSignedWebhook({ uid: p.externalUid as string, order: p.id, status: 'expired' });
    await webhook.process(body, {});
    const stored = await findPayment(p.id);
    expect(stored.status).toBe('FAILED');
    expect(stored.failureReason).toBe('expired');
  });

  it('webhook rejected → DEBT', async () => {
    const p = await chargeYape();
    const { body } = gateway.buildSignedWebhook({ uid: p.externalUid as string, order: p.id, status: 'rejected' });
    await webhook.process(body, {});
    expect((await findPayment(p.id)).status).toBe('DEBT');
  });

  it('webhook YPTRX002 (saldo insuficiente) → DEBT con reason yape_insufficient_funds', async () => {
    const p = await chargeYape();
    const { body } = gateway.buildSignedWebhook({
      uid: p.externalUid as string,
      order: p.id,
      status: 'rejected',
      error_code: 'YPTRX002',
    });
    await webhook.process(body, {});
    const stored = await findPayment(p.id);
    expect(stored.status).toBe('DEBT');
    expect(stored.failureReason).toBe('yape_insufficient_funds'); // recibo honesto
  });
});

describe('E2E ProntoPaga · tope Yape On File (2000 PEN/tx)', () => {
  it('cobro on-file > 2000 PEN degrada a QR (omite walletUid) → checkout con QR, no on-file', async () => {
    const onFileGateway = new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000', pendingExternal: true, webhookSecret: SECRET });
    const chargeSpy = vi.spyOn(onFileGateway, 'charge');
    // Afiliación ACTIVE: resolveActiveWalletUid devuelve un walletUid → intentaría on-file.
    const activeAffiliation = { resolveActiveWalletUid: async () => 'WUID-ACTIVE' } as unknown as AffiliationsService;
    const onFilePayments = new PaymentsService(prismaService, onFileGateway, activeAffiliation, noPromos, makeConfig() as never);

    const p = await onFilePayments.charge({
      tripId: '0192f8a0-0000-7000-8000-000000000099',
      grossCents: 250_000, // S/2500 > tope S/2000
      method: 'YAPE',
      dedupKey: 'trip-big',
      userId: PAX,
    });

    expect(p.status).toBe('PENDING');
    // El charge al gateway NO debe llevar walletUid (se degradó a QR).
    expect(chargeSpy).toHaveBeenCalledWith(expect.objectContaining({ walletUid: undefined }));
    expect(p.qrCode).toContain('data:image/png;base64,'); // checkout QR, no on-file silencioso
  });
});
