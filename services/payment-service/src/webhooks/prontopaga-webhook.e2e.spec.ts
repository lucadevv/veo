/**
 * E2E SIN RED: flujo PENDING_EXTERNAL → webhook firmado → CAPTURED, usando el adapter SANDBOX
 * en modo pendingExternal (mismo firmador/contrato que ProntoPaga). Prueba la idempotencia del
 * webhook, las transiciones de estado y el 401 por firma inválida. Prisma fake en memoria.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedError } from '@veo/utils';
import { ConfigService } from '@nestjs/config';
import { PaymentsService } from '../payments/payments.service';
import { ProntoPagaWebhookService } from './prontopaga-webhook.service';
import { SandboxPaymentGateway } from '../ports/gateway/sandbox.gateway';
import type { PrismaService } from '../infra/prisma.service';
import type { AffiliationsService } from '../affiliations/affiliations.service';
import type { PromotionsService } from '../promotions/promotions.service';

const SECRET = 'dev-sandbox-webhook-secret';

/** Fake Prisma para Payment + outbox. */
function makeFakePrisma() {
  const payments = new Map<string, Record<string, unknown>>();
  const byDedup = new Map<string, string>(); // dedupKey → id
  const outbox: { eventType: string; aggregateId: string }[] = [];

  const client = {
    payment: {
      findUnique: async ({ where }: { where: { id?: string; dedupKey?: string } }) => {
        if (where.id) return payments.get(where.id) ?? null;
        if (where.dedupKey) {
          const id = byDedup.get(where.dedupKey);
          return id ? payments.get(id) ?? null : null;
        }
        return null;
      },
      findFirst: async ({ where }: { where: { externalUid?: string } }) =>
        [...payments.values()].find((p) => p.externalUid === where.externalUid) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { retries: 0, ...data };
        payments.set(data.id as string, row);
        byDedup.set(data.dedupKey as string, data.id as string);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = payments.get(where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  // enqueueOutbox de @veo/database escribe en client.outboxEvent.create — lo proveemos.
  (client as Record<string, unknown>).outboxEvent = {
    create: async ({ data }: { data: { eventType: string; aggregateId: string } }) => {
      outbox.push({ eventType: data.eventType, aggregateId: data.aggregateId });
      return data;
    },
  };
  return { read: client, write: client, _payments: payments, _outbox: outbox } as unknown as PrismaService & {
    _payments: Map<string, Record<string, unknown>>;
    _outbox: { eventType: string; aggregateId: string }[];
  };
}

function makeConfig(): ConfigService {
  const values: Record<string, unknown> = {
    VEO_PAYMENT_MODE: 'prontopaga',
    COMMISSION_RATE: 0.2,
    PAYMENT_MAX_RETRIES: 3,
    PAYMENT_RETRY_BASE_MS: 1,
    DEFAULT_PAYMENT_METHOD: 'YAPE',
    REFUND_WINDOW_DAYS: 7,
    REFUND_L2_THRESHOLD_CENTS: 3000,
  };
  return { getOrThrow: (k: string) => values[k], get: (k: string) => values[k] } as unknown as ConfigService;
}

const noPromos = { redeemPromo: async () => ({ discountCents: 0 }) } as unknown as PromotionsService;
const noAffiliation = { resolveActiveWalletUid: async () => null } as unknown as AffiliationsService;

describe('E2E ProntoPaga · PENDING_EXTERNAL → webhook → CAPTURED', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let gateway: SandboxPaymentGateway;
  let payments: PaymentsService;
  let webhook: ProntoPagaWebhookService;

  beforeEach(() => {
    prisma = makeFakePrisma();
    gateway = new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000', pendingExternal: true, webhookSecret: SECRET });
    payments = new PaymentsService(prisma, gateway, noAffiliation, noPromos, makeConfig() as never);
    webhook = new ProntoPagaWebhookService(gateway, payments, noAffiliation);
  });

  async function chargeYape() {
    return payments.charge({
      tripId: '0192f8a0-0000-7000-8000-000000000001',
      grossCents: 2000,
      method: 'YAPE',
      dedupKey: 'trip-1',
      userId: '0192f8a0-0000-7000-8000-0000000000aa',
    });
  }

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

    const stored = prisma._payments.get(p.id)!;
    expect(stored.status).toBe('CAPTURED');
    expect(prisma._outbox.some((e) => e.eventType === 'payment.captured')).toBe(true);
  });

  it('webhook IDEMPOTENTE: re-entregar el mismo success no recaptura ni duplica el evento', async () => {
    const p = await chargeYape();
    const { body } = gateway.buildSignedWebhook({ uid: p.externalUid as string, order: p.id, status: 'success' });
    await webhook.process(body, {});
    await webhook.process(body, {});

    const captured = prisma._outbox.filter((e) => e.eventType === 'payment.captured');
    expect(captured.length).toBe(1); // una sola captura
  });

  it('firma inválida → UnauthorizedError (401), el pago NO cambia', async () => {
    const p = await chargeYape();
    const bad = JSON.stringify({ uid: p.externalUid, order: p.id, status: 'success', sign: 'firma-mala' });
    await expect(webhook.process(bad, {})).rejects.toBeInstanceOf(UnauthorizedError);
    expect(prisma._payments.get(p.id)!.status).toBe('PENDING');
  });

  it('webhook expired → FAILED reason expired', async () => {
    const p = await chargeYape();
    const { body } = gateway.buildSignedWebhook({ uid: p.externalUid as string, order: p.id, status: 'expired' });
    await webhook.process(body, {});
    const stored = prisma._payments.get(p.id)!;
    expect(stored.status).toBe('FAILED');
    expect(stored.failureReason).toBe('expired');
  });

  it('webhook rejected → DEBT', async () => {
    const p = await chargeYape();
    const { body } = gateway.buildSignedWebhook({ uid: p.externalUid as string, order: p.id, status: 'rejected' });
    await webhook.process(body, {});
    expect(prisma._payments.get(p.id)!.status).toBe('DEBT');
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
    const stored = prisma._payments.get(p.id)!;
    expect(stored.status).toBe('DEBT');
    expect(stored.failureReason).toBe('yape_insufficient_funds'); // recibo honesto
  });
});

describe('E2E ProntoPaga · tope Yape On File (2000 PEN/tx)', () => {
  it('cobro on-file > 2000 PEN degrada a QR (omite walletUid) → checkout con QR, no on-file', async () => {
    const prisma = makeFakePrisma();
    const gateway = new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000', pendingExternal: true, webhookSecret: SECRET });
    const chargeSpy = vi.spyOn(gateway, 'charge');
    // Afiliación ACTIVE: resolveActiveWalletUid devuelve un walletUid → intentaría on-file.
    const activeAffiliation = { resolveActiveWalletUid: async () => 'WUID-ACTIVE' } as unknown as AffiliationsService;
    const payments = new PaymentsService(prisma, gateway, activeAffiliation, noPromos, makeConfig() as never);

    const p = await payments.charge({
      tripId: '0192f8a0-0000-7000-8000-000000000099',
      grossCents: 250_000, // S/2500 > tope S/2000
      method: 'YAPE',
      dedupKey: 'trip-big',
      userId: '0192f8a0-0000-7000-8000-0000000000aa',
    });

    expect(p.status).toBe('PENDING');
    // El charge al gateway NO debe llevar walletUid (se degradó a QR).
    expect(chargeSpy).toHaveBeenCalledWith(expect.objectContaining({ walletUid: undefined }));
    expect(p.qrCode).toContain('data:image/png;base64,'); // checkout QR, no on-file silencioso
  });
});
