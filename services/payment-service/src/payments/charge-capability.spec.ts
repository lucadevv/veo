/**
 * Clasificación HONESTA del fallo de COBRO por CAPACIDAD (failureKind=capability_unavailable).
 *
 * Cuando el método elegido NO está habilitado en el comercio (ProntoPaga 400 "not enabled for commerce"),
 * el adapter devuelve un DECLINE TIPADO (failureKind=capability_unavailable). El dominio NO lo aplasta a un
 * failureReason genérico: el Payment cae a DEBT con `method_unavailable:<METHOD>` para que el bff/app digan
 * "ese método no está disponible, elegí otro" en vez de "no pudimos procesar el pago".
 *
 * Tests (sin red): fake gateway que clasifica el charge + fake Prisma en memoria.
 *  - capability_unavailable → DEBT con failureReason `method_unavailable:<METHOD>` (no genérico).
 *  - decline normal           → DEBT con el reason del riel (declined), SIN method_unavailable.
 *  - changeMethod a un método no habilitado → DEBT method_unavailable:<NUEVO> (la app sugiere otro).
 */
import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { PaymentsService } from './payments.service';
import type {
  PaymentGateway,
  GatewayChargeRequest,
  GatewayChargeResult,
} from '../ports/gateway/payment-gateway.port';
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
  commissionCents: number;
  feeCents: number;
  tipCents: number;
  method: string;
  status: string;
  failureReason: string | null;
  payerRef: string | null;
  dedupKey: string;
  retries: number;
  createdAt: Date;
  externalRef: string | null;
  externalUid: string | null;
  checkoutUrl: string | null;
  deepLink: string | null;
  qrCode: string | null;
  cip: string | null;
  checkoutExpiresAt: Date | null;
  capturedAt: Date | null;
}

type StatusWhere = string | { in: string[] } | undefined;
function statusMatches(rowStatus: string, where: StatusWhere): boolean {
  if (where === undefined) return true;
  if (typeof where === 'string') return rowStatus === where;
  return where.in.includes(rowStatus);
}

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

function makeConfig(): ConfigService<Env, true> {
  const values: Record<string, unknown> = {
    VEO_PAYMENT_MODE: 'prontopaga',
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

/** Gateway que devuelve un result fijo en charge (clasificación inyectada por test). */
function fixedGateway(result: GatewayChargeResult): PaymentGateway {
  return {
    charge: async (_req: GatewayChargeRequest) => result,
    getStatement: async () => [],
  };
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: over.id ?? '0192f8a0-0000-7000-8000-000000000e01',
    tripId: over.tripId ?? '0192f8a0-0000-7000-8000-000000000t01',
    passengerId: over.passengerId ?? PAX,
    amountCents: over.amountCents ?? 2300,
    grossCents: over.grossCents ?? 2000,
    commissionCents: over.commissionCents ?? 400,
    feeCents: over.feeCents ?? 0,
    tipCents: over.tipCents ?? 0,
    method: over.method ?? 'PAGOEFECTIVO',
    status: over.status ?? 'PENDING',
    failureReason: over.failureReason ?? null,
    payerRef: over.payerRef ?? null,
    dedupKey: over.dedupKey ?? `trip-completed:${over.tripId ?? 't01'}`,
    retries: over.retries ?? 0,
    createdAt: over.createdAt ?? new Date('2026-06-01T00:00:00Z'),
    externalRef: over.externalRef ?? null,
    externalUid: over.externalUid ?? null,
    checkoutUrl: over.checkoutUrl ?? null,
    deepLink: over.deepLink ?? null,
    qrCode: over.qrCode ?? null,
    cip: over.cip ?? null,
    checkoutExpiresAt: over.checkoutExpiresAt ?? null,
    capturedAt: over.capturedAt ?? null,
  };
}

describe('cobro · clasificación honesta del fallo por capacidad', () => {
  it('changeMethod a un método NO habilitado → DEBT con failureReason method_unavailable:<METHOD>', async () => {
    const r = row({ method: 'YAPE', status: 'DEBT', failureReason: 'yape_insufficient_funds' });
    const prisma = makeFakePrisma([r]);
    const gw = fixedGateway({ status: 'DECLINED', failureKind: 'capability_unavailable', reason: 'not enabled' });
    const svc = new PaymentsService(prisma, gw, noAffiliation, noPromos, makeConfig());

    const out = await svc.changeMethod(r.id, 'PAGOEFECTIVO');
    expect(out.status).toBe('DEBT');
    // Razón ESTRUCTURADA por-método (no el reason crudo del proveedor ni un genérico).
    expect(out.failureReason).toBe('method_unavailable:PAGOEFECTIVO');
  });

  it('decline NORMAL (sin failureKind) → DEBT con el reason del riel, NO method_unavailable', async () => {
    const r = row({ method: 'YAPE', status: 'DEBT', failureReason: null });
    const prisma = makeFakePrisma([r]);
    const gw = fixedGateway({ status: 'DECLINED', reason: 'declined' });
    const svc = new PaymentsService(prisma, gw, noAffiliation, noPromos, makeConfig());

    const out = await svc.changeMethod(r.id, 'PLIN');
    expect(out.status).toBe('DEBT');
    expect(out.failureReason).toBe('declined');
    expect(out.failureReason).not.toMatch(/method_unavailable/);
  });

  it('retryCharge sobre un método no habilitado → DEBT method_unavailable:<METHOD> (no loop ciego)', async () => {
    const r = row({ method: 'PAGOEFECTIVO', status: 'DEBT', failureReason: 'method_unavailable:PAGOEFECTIVO' });
    const prisma = makeFakePrisma([r]);
    const gw = fixedGateway({ status: 'DECLINED', failureKind: 'capability_unavailable', reason: 'not enabled' });
    const svc = new PaymentsService(prisma, gw, noAffiliation, noPromos, makeConfig());

    const out = await svc.retryCharge(r.id);
    expect(out.status).toBe('DEBT');
    expect(out.failureReason).toBe('method_unavailable:PAGOEFECTIVO');
  });
});
