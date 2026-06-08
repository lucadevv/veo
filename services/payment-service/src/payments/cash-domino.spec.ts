/**
 * EFECTIVO · cierre del dominó (decisión del dueño: el efectivo se confirma AL TERMINAR el viaje).
 *
 * chargeFromTripCompleted con cashCollected:
 *   - method=CASH + cashCollected=true → crea Payment CASH PENDING + CashConfirmation driverConfirmed=true
 *     y emite payment.cash_pending (push al pasajero). NO captura todavía (falta el pasajero).
 *   - luego confirmCash(party:'passenger') → ambos true → CAPTURED + payment.captured.
 *   - method=CASH SIN cashCollected → bilateral normal: driverConfirmed=false, NO emite cash_pending.
 *   - caso raro: el pasajero confirmó ANTES de existir el Payment → al crear con cashCollected → CAPTURA directo.
 *   - DIGITAL (YAPE) con cashCollected=true → se ignora (el cobro va por el riel, no toca CashConfirmation).
 *   - idempotencia: reprocesar el mismo trip.completed no duplica la confirmación ni recaptura.
 *
 * Prisma fake en memoria (sin red): payment + cashConfirmation + outbox. No mockeamos un crítico parcialmente.
 */
import { describe, it, expect } from 'vitest';
import { type ConfigService } from '@nestjs/config';
import { PaymentsService } from './payments.service';
import { SandboxPaymentGateway } from '../ports/gateway/sandbox.gateway';
import { deriveTripChargeDedupKey } from './payment.policy';
import type { PrismaService } from '../infra/prisma.service';
import type { AffiliationsService } from '../affiliations/affiliations.service';
import type { PromotionsService } from '../promotions/promotions.service';
import type { Env } from '../config/env.schema';

const TRIP = '0192f8a0-0000-7000-8000-0000000000t1';
const PAX = '0192f8a0-0000-7000-8000-0000000000aa';

interface PaymentRow {
  id: string;
  tripId: string;
  driverId: string | null;
  passengerId: string | null;
  dedupKey: string;
  amountCents: number;
  grossCents: number;
  discountCents: number;
  tipCents: number;
  commissionCents: number;
  feeCents: number;
  method: string;
  status: string;
  capturedAt: Date | null;
  externalRef: string | null;
  payerRef: string | null;
  retries: number;
  failureReason: string | null;
  externalUid: string | null;
  checkoutUrl: string | null;
  qrCode: string | null;
  deepLink: string | null;
  cip: string | null;
  checkoutExpiresAt: Date | null;
  createdAt: Date;
}

interface CashRow {
  id: string;
  tripId: string;
  driverConfirmed: boolean;
  passengerConfirmed: boolean;
}

/** Prisma fake total: payment (create/findUnique/update), cashConfirmation (upsert/findUnique) y outbox. */
function makeFakePrisma() {
  const payments = new Map<string, PaymentRow>();
  const cash = new Map<string, CashRow>(); // por tripId
  const outbox: { eventType: string; aggregateId: string }[] = [];

  const client = {
    payment: {
      findUnique: async ({ where }: { where: { id?: string; dedupKey?: string } }) => {
        if (where.id) return payments.get(where.id) ?? null;
        if (where.dedupKey) return [...payments.values()].find((p) => p.dedupKey === where.dedupKey) ?? null;
        return null;
      },
      findFirst: async ({ where }: { where: { tripId?: string; status?: string } }) =>
        [...payments.values()].find(
          (p) =>
            (where.tripId === undefined || p.tripId === where.tripId) &&
            (where.status === undefined || p.status === where.status),
        ) ?? null,
      findMany: async ({ where }: { where: { passengerId?: string; status?: string } }) =>
        [...payments.values()].filter(
          (p) =>
            (where.passengerId === undefined || p.passengerId === where.passengerId) &&
            (where.status === undefined || p.status === where.status),
        ),
      create: async ({ data }: { data: Partial<PaymentRow> }) => {
        const row = { ...(data as PaymentRow) };
        payments.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<PaymentRow> }) => {
        const r = payments.get(where.id)!;
        Object.assign(r, data);
        return r;
      },
    },
    cashConfirmation: {
      findUnique: async ({ where }: { where: { tripId: string } }) => cash.get(where.tripId) ?? null,
      upsert: async ({
        where,
        update,
        create,
      }: {
        where: { tripId: string };
        update: Partial<CashRow>;
        create: { id: string; tripId: string } & Partial<CashRow>;
      }) => {
        const existing = cash.get(where.tripId);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row: CashRow = { driverConfirmed: false, passengerConfirmed: false, ...create };
        cash.set(where.tripId, row);
        return row;
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
  return { read: client, write: client, _payments: payments, _cash: cash, _outbox: outbox } as unknown as PrismaService & {
    _payments: Map<string, PaymentRow>;
    _cash: Map<string, CashRow>;
    _outbox: { eventType: string; aggregateId: string }[];
  };
}

function makeConfig(): ConfigService<Env, true> {
  const values: Record<string, unknown> = {
    VEO_PAYMENT_MODE: 'sandbox',
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

function makeSvc(prisma: PrismaService) {
  const gateway = new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' });
  return new PaymentsService(prisma, gateway, noAffiliation, noPromos, makeConfig());
}

function chargeCash(svc: PaymentsService, opts: { cashCollected?: boolean } = {}) {
  return svc.chargeFromTripCompleted({
    tripId: TRIP,
    grossCents: 2000,
    dedupKey: deriveTripChargeDedupKey(TRIP),
    method: 'CASH',
    userId: PAX,
    cashCollected: opts.cashCollected,
  });
}

describe('chargeFromTripCompleted · EFECTIVO con cashCollected (driver confirma al terminar)', () => {
  it('CASH + cashCollected=true → PENDING + CashConfirmation driverConfirmed=true + emite cash_pending', async () => {
    const prisma = makeFakePrisma();
    const svc = makeSvc(prisma);

    const payment = await chargeCash(svc, { cashCollected: true });

    expect(payment.method).toBe('CASH');
    expect(payment.status).toBe('PENDING'); // NO captura: falta el pasajero
    const conf = prisma._cash.get(TRIP);
    expect(conf?.driverConfirmed).toBe(true);
    expect(conf?.passengerConfirmed).toBe(false);
    // Push al pasajero "confirma tu pago en efectivo".
    expect(prisma._outbox.some((e) => e.eventType === 'payment.cash_pending')).toBe(true);
    // NO se capturó todavía (no hay payment.captured).
    expect(prisma._outbox.some((e) => e.eventType === 'payment.captured')).toBe(false);
  });

  it('luego el PASAJERO confirma → ambos true → CAPTURED + payment.captured', async () => {
    const prisma = makeFakePrisma();
    const svc = makeSvc(prisma);

    const payment = await chargeCash(svc, { cashCollected: true });
    const out = await svc.confirmCash(payment.id, 'passenger', true);

    expect(out.status).toBe('CAPTURED');
    expect(out.driverConfirmed).toBe(true);
    expect(out.passengerConfirmed).toBe(true);
    const final = await svc.getPayment(payment.id);
    expect(final.status).toBe('CAPTURED');
    expect(prisma._outbox.some((e) => e.eventType === 'payment.captured')).toBe(true);
  });

  it('CASH SIN cashCollected → bilateral normal: driverConfirmed=false, NO emite cash_pending', async () => {
    const prisma = makeFakePrisma();
    const svc = makeSvc(prisma);

    const payment = await chargeCash(svc); // sin cashCollected

    expect(payment.status).toBe('PENDING');
    // Ninguna CashConfirmation creada (el conductor no confirmó nada todavía).
    expect(prisma._cash.get(TRIP)).toBeUndefined();
    expect(prisma._outbox.some((e) => e.eventType === 'payment.cash_pending')).toBe(false);
  });

  it('caso raro: el pasajero confirmó ANTES de existir el Payment → al crear con cashCollected → CAPTURA directo', async () => {
    const prisma = makeFakePrisma();
    const svc = makeSvc(prisma);

    // El pasajero confirmó primero (confirmCash hace upsert aunque no exista el Payment todavía... pero
    // confirmCash exige el Payment; modelamos el caso sembrando la CashConfirmation passengerConfirmed=true).
    prisma._cash.set(TRIP, { id: 'cc-1', tripId: TRIP, driverConfirmed: false, passengerConfirmed: true });

    const payment = await chargeCash(svc, { cashCollected: true });

    const final = await svc.getPayment(payment.id);
    expect(final.status).toBe('CAPTURED'); // ambos true → captura inmediata
    expect(prisma._outbox.some((e) => e.eventType === 'payment.captured')).toBe(true);
    // No tiene sentido pedir confirmación al pasajero si ya capturó: no se emite cash_pending.
    expect(prisma._outbox.some((e) => e.eventType === 'payment.cash_pending')).toBe(false);
  });

  it('DIGITAL (YAPE) con cashCollected=true → se IGNORA: no toca CashConfirmation ni emite cash_pending', async () => {
    const prisma = makeFakePrisma();
    const svc = makeSvc(prisma);

    await svc.chargeFromTripCompleted({
      tripId: TRIP,
      grossCents: 2000,
      dedupKey: deriveTripChargeDedupKey(TRIP),
      method: 'YAPE', // sandbox sin payerRef declinante → captura por el riel
      userId: PAX,
      cashCollected: true, // ruido para digital
    });

    expect(prisma._cash.get(TRIP)).toBeUndefined();
    expect(prisma._outbox.some((e) => e.eventType === 'payment.cash_pending')).toBe(false);
  });

  it('idempotente: reprocesar el MISMO trip.completed no duplica la confirmación ni recaptura', async () => {
    const prisma = makeFakePrisma();
    const svc = makeSvc(prisma);

    // 1º proceso: driver confirma, queda PENDING + cash_pending.
    const p = await chargeCash(svc, { cashCollected: true });
    // El pasajero confirma → CAPTURED.
    await svc.confirmCash(p.id, 'passenger', true);
    const capturesBefore = prisma._outbox.filter((e) => e.eventType === 'payment.captured').length;

    // Redelivery del MISMO trip.completed: charge devuelve el Payment existente (dedupKey UNIQUE). Como ya
    // está CAPTURED (no PENDING), NO se re-aplica la confirmación del conductor ni se re-emite nada.
    await chargeCash(svc, { cashCollected: true });

    const capturesAfter = prisma._outbox.filter((e) => e.eventType === 'payment.captured').length;
    expect(capturesAfter).toBe(capturesBefore); // sin doble captura
    const final = await svc.getPayment(p.id);
    expect(final.status).toBe('CAPTURED');
  });
});

describe('REGLA DE BORDE · un CASH PENDING con driverConfirmed (sin confirmar el pasajero) NO bloquea ni es accionable', () => {
  it('queda PENDING pero NO es DEBT (no bloquea pedir viajes) y NO es PENDING_ACTION (sin checkout)', async () => {
    const prisma = makeFakePrisma();
    const svc = makeSvc(prisma);

    // El conductor cobró y confirmó al terminar; el pasajero NUNCA confirma → el Payment queda PENDING.
    const payment = await chargeCash(svc, { cashCollected: true });
    expect(payment.status).toBe('PENDING');
    expect(prisma._cash.get(TRIP)?.driverConfirmed).toBe(true);

    // El gate de DEBT y la query de PENDING_ACTION NO lo agarran: un CASH sin external_uid no es accionable
    // (no tiene checkout) y no es deuda (el conductor ya cobró en mano; no es deuda del pasajero).
    const debt = await svc.getDebtForPassenger(PAX);
    expect(debt.hasDebt).toBe(false); // NO bloquea POST /trips
    expect(debt.totalCents).toBe(0);
    expect(debt.debts).toEqual([]); // ni DEBT ni PENDING_ACTION
  });
});
