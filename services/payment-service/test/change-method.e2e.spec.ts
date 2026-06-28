/**
 * changeMethod (cambio de método de un pago no-capturado) · E2E con Postgres REAL (testcontainers) —
 * NO se mockea la DB en un crítico de dinero (CLAUDE). Reemplaza al antiguo change-method.spec.ts.
 *
 * Un pago PENDING/DEBT de un viaje YA HECHO puede CAMBIAR entre medios DIGITALES y re-cobrar con el
 * método nuevo. CASH no aplica (bilateral). CAPTURED/REFUNDED ya no se cambian. Status-guard concurrente.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { InvalidStateError, NotFoundError, UnprocessableEntityError, uuidv7 } from '@veo/utils';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../src/generated/prisma';
import { PaymentsService } from '../src/payments/payments.service';
import { SandboxPaymentGateway } from '../src/ports/gateway/sandbox.gateway';
import type { PrismaService } from '../src/infra/prisma.service';
import type { AffiliationsService } from '../src/affiliations/affiliations.service';
import type { PromotionsService } from '../src/promotions/promotions.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));
const PAX = '0192f8a0-0000-7000-8000-0000000000aa';

let db: TestDatabase;
let prisma: PrismaClient;
let svc: PaymentsService;

const noPromos = {
  redeemPromo: async () => ({ discountCents: 0 }),
} as unknown as PromotionsService;
const noAffiliation = {
  resolveActiveWalletUid: async () => null,
} as unknown as AffiliationsService;

function makeConfig(): ConfigService {
  const values: Record<string, unknown> = {
    VEO_PAYMENT_MODE: 'prontopaga',
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

interface SeedOver {
  method?: string;
  status?: string;
  failureReason?: string | null;
  externalUid?: string | null;
  deepLink?: string | null;
}

/** Pago PENDING con un checkout YAPE vivo (deepLink/uid) — el caso real del dueño. */
async function seedRow(over: SeedOver = {}): Promise<{ id: string; tripId: string }> {
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
      method: (over.method ?? 'YAPE') as never,
      status: (over.status ?? 'PENDING') as never,
      failureReason: over.failureReason === undefined ? null : over.failureReason,
      externalUid: over.externalUid === undefined ? '01KTHPQ6RPD4J2P7NWFKGRNPJG' : over.externalUid,
      deepLink: over.deepLink === undefined ? 'yapeapp:oneshot/OLD' : over.deepLink,
    },
  });
  return { id, tripId };
}

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'payment',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  const gateway = new SandboxPaymentGateway({
    confirmDelayMs: 0,
    declineSuffix: '0000',
    pendingExternal: true,
    webhookSecret: 'sec',
  });
  svc = new PaymentsService(prismaService, gateway, noAffiliation, noPromos, makeConfig() as never);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

beforeEach(async () => {
  await prisma.outboxEvent.deleteMany({});
  await prisma.payment.deleteMany({});
});

describe('changeMethod (cambio de método de un pago no-capturado)', () => {
  it('PENDING YAPE → PLIN (prontopaga): method=PLIN, status PENDING, CHECKOUT NUEVO, checkout viejo limpiado', async () => {
    const { id } = await seedRow({
      method: 'YAPE',
      deepLink: 'yapeapp:oneshot/OLD',
      externalUid: 'uid-old',
    });
    const out = await svc.changeMethod(id, 'PLIN');
    expect(out.method).toBe('PLIN');
    expect(out.status).toBe('PENDING'); // espera webhook/poll
    expect(out.checkoutUrl ?? out.qrCode).toBeTruthy(); // checkout NUEVO
    expect(out.deepLink).not.toBe('yapeapp:oneshot/OLD'); // el viejo no sobrevive
  });

  it('DEBT YAPE → PLIN: normaliza a PENDING y re-cobra con el método nuevo', async () => {
    const { id } = await seedRow({
      method: 'YAPE',
      status: 'DEBT',
      failureReason: 'yape_insufficient_funds',
      deepLink: null,
    });
    const out = await svc.changeMethod(id, 'PLIN');
    expect(out.method).toBe('PLIN');
    expect(out.status).toBe('PENDING');
    expect(out.failureReason).toBeNull();
  });

  it('CASH → UnprocessableEntityError (422): el efectivo no aplica a un pago pendiente', async () => {
    const { id } = await seedRow({ method: 'YAPE' });
    await expect(svc.changeMethod(id, 'CASH')).rejects.toBeInstanceOf(UnprocessableEntityError);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id } })).method).toBe('YAPE'); // no tocó
  });

  it('CAPTURED → InvalidStateError (409): ya no se puede cambiar', async () => {
    const { id } = await seedRow({ method: 'YAPE', status: 'CAPTURED' });
    await expect(svc.changeMethod(id, 'PLIN')).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('REFUNDED → InvalidStateError (409)', async () => {
    const { id } = await seedRow({ method: 'YAPE', status: 'REFUNDED' });
    await expect(svc.changeMethod(id, 'PLIN')).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('no-op idempotente: mismo método pedido → estado vigente, sin re-cobrar (checkout viejo intacto)', async () => {
    const { id } = await seedRow({
      method: 'YAPE',
      deepLink: 'yapeapp:oneshot/OLD',
      externalUid: 'uid-old',
    });
    const out = await svc.changeMethod(id, 'YAPE');
    expect(out.method).toBe('YAPE');
    expect(out.deepLink).toBe('yapeapp:oneshot/OLD'); // no re-cobró
    expect(out.externalUid).toBe('uid-old');
  });

  it('concurrencia: el status-guard (updateMany where status in (PENDING,DEBT)) deja cambiar a UNO solo', async () => {
    const { id } = await seedRow({ method: 'YAPE' });
    const [a, b] = await Promise.all([svc.changeMethod(id, 'PLIN'), svc.changeMethod(id, 'PLIN')]);
    expect(a.id).toBe(b.id);
    const final = await svc.getPayment(id);
    expect(final.method).toBe('PLIN');
    expect(final.status).toBe('PENDING');
  });

  it('pago inexistente → NotFoundError', async () => {
    await expect(svc.changeMethod(uuidv7(), 'PLIN')).rejects.toBeInstanceOf(NotFoundError);
  });
});
