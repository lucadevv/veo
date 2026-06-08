/**
 * changeMethod (cambio de método de un pago no-capturado) · payment-service.
 *
 * DECISIÓN DEL DUEÑO: un pago PENDING/DEBT de un viaje YA HECHO que el usuario no pudo pagar (no le
 * anduvo el Yape) puede CAMBIAR de método entre medios DIGITALES y re-cobrar con el método nuevo.
 * Tests:
 *  - cambio digital→digital (prontopaga) → PENDING con CHECKOUT NUEVO + Payment.method actualizado.
 *  - CASH → UnprocessableEntityError (422): el efectivo se salda bilateral, no aplica a un pendiente.
 *  - CAPTURED/REFUNDED → InvalidStateError (409): ya no se puede cambiar.
 *  - no-op idempotente: mismo método pedido → estado vigente, sin re-cobrar (sin checkout nuevo).
 *  - concurrencia: status-guard (updateMany where status in (PENDING,DEBT)) deja pasar a UNO solo.
 *  - DEBT→PENDING al cambiar; los checkout fields viejos se LIMPIAN.
 * Prisma fake en memoria (sin red): doble determinista y total (no mockeamos un crítico parcialmente).
 */
import { describe, it, expect } from 'vitest';
import { type ConfigService } from '@nestjs/config';
import { InvalidStateError, NotFoundError, UnprocessableEntityError } from '@veo/utils';
import { PaymentsService } from './payments.service';
import { SandboxPaymentGateway } from '../ports/gateway/sandbox.gateway';
import type { PrismaService } from '../infra/prisma.service';
import type { AffiliationsService } from '../affiliations/affiliations.service';
import type { PromotionsService } from '../promotions/promotions.service';
import type { Env } from '../config/env.schema';

const PAX = '0192f8a0-0000-7000-8000-0000000000aa';

interface Row {
  id: string;
  tripId: string;
  passengerId: string | null;
  amountCents: number;
  grossCents: number;
  method: string;
  status: string;
  failureReason: string | null;
  payerRef: string | null;
  dedupKey: string;
  retries: number;
  createdAt: Date;
  externalUid: string | null;
  checkoutUrl: string | null;
  deepLink: string | null;
  qrCode: string | null;
  cip: string | null;
  checkoutExpiresAt: Date | null;
}

/** where.status puede ser un string exacto o `{ in: string[] }` (status-guard del cambio de método). */
type StatusWhere = string | { in: string[] } | undefined;
function statusMatches(rowStatus: string, where: StatusWhere): boolean {
  if (where === undefined) return true;
  if (typeof where === 'string') return rowStatus === where;
  return where.in.includes(rowStatus);
}

/** Fake Prisma con findUnique/update/updateMany (soporta `status: { in }`) + outbox, en memoria. */
function makeFakePrisma(seed: Row[]) {
  const rows = new Map<string, Row>(seed.map((r) => [r.id, r]));
  const outbox: { eventType: string; aggregateId: string }[] = [];
  const client = {
    payment: {
      findUnique: async ({ where }: { where: { id?: string; dedupKey?: string } }) => {
        if (where.id) return rows.get(where.id) ?? null;
        if (where.dedupKey) return [...rows.values()].find((r) => r.dedupKey === where.dedupKey) ?? null;
        return null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const r = rows.get(where.id)!;
        Object.assign(r, data);
        return r;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: StatusWhere };
        data: Partial<Row>;
      }) => {
        const r = rows.get(where.id);
        if (!r || !statusMatches(r.status, where.status)) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  (client as Record<string, unknown>).outboxEvent = {
    create: async ({ data }: { data: { eventType: string; aggregateId: string } }) => {
      outbox.push({ eventType: data.eventType, aggregateId: data.aggregateId });
      return data;
    },
  };
  return { read: client, write: client, _rows: rows, _outbox: outbox } as unknown as PrismaService & {
    _rows: Map<string, Row>;
    _outbox: { eventType: string; aggregateId: string }[];
  };
}

function makeConfig(mode: 'sandbox' | 'prontopaga' = 'prontopaga'): ConfigService<Env, true> {
  const values: Record<string, unknown> = {
    VEO_PAYMENT_MODE: mode,
    COMMISSION_RATE: 0.2,
    PAYMENT_MAX_RETRIES: 3,
    PAYMENT_RETRY_BASE_MS: 1,
    DEFAULT_PAYMENT_METHOD: 'YAPE',
    REFUND_WINDOW_DAYS: 7,
    REFUND_L2_THRESHOLD_CENTS: 3000,
  };
  return { getOrThrow: (k: string) => values[k], get: (k: string) => values[k] } as unknown as ConfigService<Env, true>;
}

const noPromos = { redeemPromo: async () => ({ discountCents: 0 }) } as unknown as PromotionsService;
const noAffiliation = { resolveActiveWalletUid: async () => null } as unknown as AffiliationsService;

/** Pago PENDING con un checkout YAPE vivo (deepLink/uid) — el caso real del dueño. */
function row(over: Partial<Row> = {}): Row {
  return {
    id: over.id ?? '0192f8a0-0000-7000-8000-000000000d01',
    tripId: over.tripId ?? '0192f8a0-0000-7000-8000-000000000t01',
    passengerId: over.passengerId ?? PAX,
    amountCents: over.amountCents ?? 2300,
    grossCents: over.grossCents ?? 2000,
    method: over.method ?? 'YAPE',
    status: over.status ?? 'PENDING',
    failureReason: over.failureReason ?? null,
    payerRef: over.payerRef ?? null,
    dedupKey: over.dedupKey ?? `trip-completed:${over.tripId ?? 't01'}`,
    retries: over.retries ?? 0,
    createdAt: over.createdAt ?? new Date('2026-06-01T00:00:00Z'),
    externalUid: over.externalUid ?? '01KTHPQ6RPD4J2P7NWFKGRNPJG',
    checkoutUrl: over.checkoutUrl ?? null,
    deepLink: over.deepLink ?? 'yapeapp:oneshot/OLD',
    qrCode: over.qrCode ?? null,
    cip: over.cip ?? null,
    checkoutExpiresAt: over.checkoutExpiresAt ?? null,
  };
}

function prontopagaGateway(): SandboxPaymentGateway {
  return new SandboxPaymentGateway({
    confirmDelayMs: 0,
    declineSuffix: '0000',
    pendingExternal: true,
    webhookSecret: 'sec',
  });
}

describe('changeMethod (cambio de método de un pago no-capturado)', () => {
  it('PENDING YAPE → PLIN (prontopaga): Payment.method=PLIN, status PENDING, CHECKOUT NUEVO, checkout viejo limpiado', async () => {
    const r = row({ method: 'YAPE', deepLink: 'yapeapp:oneshot/OLD', externalUid: 'uid-old' });
    const prisma = makeFakePrisma([r]);
    const svc = new PaymentsService(prisma, prontopagaGateway(), noAffiliation, noPromos, makeConfig('prontopaga'));

    const out = await svc.changeMethod(r.id, 'PLIN');
    expect(out.method).toBe('PLIN');
    expect(out.status).toBe('PENDING'); // espera webhook/poll
    // Checkout NUEVO persistido (urlPay o qr del método nuevo); el viejo deepLink Yape NO sobrevive.
    expect(out.checkoutUrl ?? out.qrCode).toBeTruthy();
    expect(out.deepLink).not.toBe('yapeapp:oneshot/OLD');
  });

  it('DEBT YAPE → PLIN: normaliza a PENDING y re-cobra con el método nuevo', async () => {
    const r = row({ method: 'YAPE', status: 'DEBT', failureReason: 'yape_insufficient_funds', deepLink: null });
    const prisma = makeFakePrisma([r]);
    const svc = new PaymentsService(prisma, prontopagaGateway(), noAffiliation, noPromos, makeConfig('prontopaga'));

    const out = await svc.changeMethod(r.id, 'PLIN');
    expect(out.method).toBe('PLIN');
    expect(out.status).toBe('PENDING');
    expect(out.failureReason).toBeNull();
  });

  it('CASH → UnprocessableEntityError (422): el efectivo no aplica a un pago pendiente', async () => {
    const r = row({ method: 'YAPE' });
    const prisma = makeFakePrisma([r]);
    const svc = new PaymentsService(prisma, prontopagaGateway(), noAffiliation, noPromos, makeConfig('prontopaga'));
    await expect(svc.changeMethod(r.id, 'CASH')).rejects.toBeInstanceOf(UnprocessableEntityError);
    // No tocó el pago.
    expect(prisma._rows.get(r.id)?.method).toBe('YAPE');
  });

  it('CAPTURED → InvalidStateError (409): ya no se puede cambiar', async () => {
    const r = row({ method: 'YAPE', status: 'CAPTURED' });
    const prisma = makeFakePrisma([r]);
    const svc = new PaymentsService(prisma, prontopagaGateway(), noAffiliation, noPromos, makeConfig('prontopaga'));
    await expect(svc.changeMethod(r.id, 'PLIN')).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('REFUNDED → InvalidStateError (409)', async () => {
    const r = row({ method: 'YAPE', status: 'REFUNDED' });
    const prisma = makeFakePrisma([r]);
    const svc = new PaymentsService(prisma, prontopagaGateway(), noAffiliation, noPromos, makeConfig('prontopaga'));
    await expect(svc.changeMethod(r.id, 'PLIN')).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('no-op idempotente: mismo método pedido → estado vigente, sin re-cobrar (checkout viejo intacto)', async () => {
    const r = row({ method: 'YAPE', deepLink: 'yapeapp:oneshot/OLD', externalUid: 'uid-old' });
    const prisma = makeFakePrisma([r]);
    const svc = new PaymentsService(prisma, prontopagaGateway(), noAffiliation, noPromos, makeConfig('prontopaga'));

    const out = await svc.changeMethod(r.id, 'YAPE');
    expect(out.method).toBe('YAPE');
    // No re-cobró: el checkout vivo del mismo medio queda tal cual (no se rompe un pago en curso).
    expect(out.deepLink).toBe('yapeapp:oneshot/OLD');
    expect(out.externalUid).toBe('uid-old');
  });

  it('concurrencia: el status-guard (updateMany where status in (PENDING,DEBT)) deja cambiar a UNO solo', async () => {
    const r = row({ method: 'YAPE' });
    const prisma = makeFakePrisma([r]);
    const svc = new PaymentsService(prisma, prontopagaGateway(), noAffiliation, noPromos, makeConfig('prontopaga'));

    const [a, b] = await Promise.all([svc.changeMethod(r.id, 'PLIN'), svc.changeMethod(r.id, 'PLIN')]);
    expect(a.id).toBe(b.id);
    const final = await svc.getPayment(r.id);
    expect(final.method).toBe('PLIN');
    expect(final.status).toBe('PENDING');
  });

  it('pago inexistente → NotFoundError', async () => {
    const prisma = makeFakePrisma([]);
    const svc = new PaymentsService(prisma, prontopagaGateway(), noAffiliation, noPromos, makeConfig('prontopaga'));
    await expect(svc.changeMethod('nope', 'PLIN')).rejects.toBeInstanceOf(NotFoundError);
  });
});
