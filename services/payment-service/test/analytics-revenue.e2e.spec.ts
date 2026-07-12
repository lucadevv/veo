/**
 * E2E con Postgres REAL (testcontainers) — las métricas de revenue de la pantalla "Métricas" del admin son
 * MONEY-CRITICAL: money-in al banco, comisión bruta, reembolsos y margen alimentan decisiones de negocio. Sin
 * mock de DB (CLAUDE: el dinero no se mockea). Verifica la agregación PROPIA de payment-service:
 *  - money-in = Σ netSettledCents de DIGITALES CAPTURED/PARTIALLY_REFUNDED (excluye CASH y REFUNDED totales),
 *  - comisión bruta = Σ commissionCents del MISMO cohorte,
 *  - reembolsos = Σ Refund.amountCents COMPLETED (por createdAt, incluye parciales+totales),
 *  - `tripCount` = conteo de cobros kind=FARE del cohorte (el TIP NO cuenta como viaje),
 *  - `byMode` = Σ netSettled por `Payment.mode` (2-way ON_DEMAND | CARPOOLING),
 *  - `previous` = totales de la ventana anterior (misma duración) → deltas del bff,
 *  - los límites de rango en TZ America/Lima (today vs 7d vs 30d vs 90d),
 *  - la serie por bucket (hora en today, día en 7d/30d/90d) reconcilia EXACTA con moneyInCents.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { uuidv7 } from '@veo/utils';
import { PrismaClient } from '../src/generated/prisma';
import { AnalyticsService, RevenueRange } from '../src/analytics/analytics.service';
import { AnalyticsRepository } from '../src/analytics/analytics.repository';
import type { PrismaService } from '../src/infra/prisma.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));

let db: TestDatabase;
let prisma: PrismaClient;
let analytics: AnalyticsService;

// Reloj FIJO del test: 2026-07-15 12:00 UTC (07:00 Lima). Medianoche Lima de hoy = 2026-07-15T05:00:00Z.
const NOW = new Date('2026-07-15T12:00:00Z');

type Method = 'YAPE' | 'PLIN' | 'CARD' | 'CASH';
type Status = 'CAPTURED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
type Mode = 'ON_DEMAND' | 'CARPOOLING';
type Kind = 'FARE' | 'TIP';

async function seedPayment(args: {
  method: Method;
  status: Status;
  netSettledCents: number | null;
  commissionCents: number;
  capturedAt: string;
  /** default ON_DEMAND (default del schema) si no se pasa. */
  mode?: Mode;
  /** default FARE (default del schema) si no se pasa. */
  kind?: Kind;
}): Promise<string> {
  const id = uuidv7();
  await prisma.payment.create({
    data: {
      id,
      tripId: uuidv7(),
      dedupKey: `trip-${id}`,
      amountCents: args.netSettledCents ?? args.commissionCents,
      grossCents: args.netSettledCents ?? args.commissionCents,
      commissionCents: args.commissionCents,
      feeCents: 0,
      netSettledCents: args.netSettledCents,
      method: args.method,
      status: args.status,
      mode: args.mode,
      kind: args.kind,
      capturedAt: new Date(args.capturedAt),
    },
  });
  return id;
}

async function seedRefund(args: {
  paymentId: string;
  amountCents: number;
  status: 'PENDING' | 'COMPLETED';
  createdAt: string;
}): Promise<void> {
  await prisma.refund.create({
    data: {
      id: uuidv7(),
      paymentId: args.paymentId,
      amountCents: args.amountCents,
      requestedBy: 'op-test',
      reason: 'test',
      status: args.status,
      createdAt: new Date(args.createdAt),
    },
  });
}

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'payment',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
  analytics = new AnalyticsService(
    new AnalyticsRepository({ read: prisma } as unknown as PrismaService),
  );

  // ── Cobros digitales (cohorte de money-in + comisión). mode/kind por default = ON_DEMAND/FARE. ──
  const p1 = await seedPayment({
    method: 'YAPE',
    status: 'CAPTURED',
    netSettledCents: 1000,
    commissionCents: 200,
    capturedAt: '2026-07-15T14:00:00Z', // hoy · Lima 09:00
  });
  await seedPayment({
    method: 'PLIN',
    status: 'CAPTURED',
    netSettledCents: 500,
    commissionCents: 100,
    capturedAt: '2026-07-15T16:30:00Z', // hoy · Lima 11:30
  });
  const p3 = await seedPayment({
    method: 'CARD',
    status: 'CAPTURED',
    netSettledCents: 800,
    commissionCents: 160,
    capturedAt: '2026-07-12T15:00:00Z', // hace 3 días · dentro de 7d/30d/90d
  });
  const p4 = await seedPayment({
    method: 'YAPE',
    status: 'CAPTURED',
    netSettledCents: 700,
    commissionCents: 140,
    capturedAt: '2026-06-25T15:00:00Z', // hace 20 días · dentro de 30d/90d
  });
  // Hace 40 días: FUERA de 30d, pero DENTRO de 90d (rango actual) y DENTRO del período PREVIO de 30d.
  await seedPayment({
    method: 'YAPE',
    status: 'CAPTURED',
    netSettledCents: 900,
    commissionCents: 180,
    capturedAt: '2026-06-05T15:00:00Z',
  });

  // ── Modo CARPOOLING (para byMode 2-way) + propina TIP (NO cuenta como viaje). Ambos HOY. ──
  await seedPayment({
    method: 'YAPE',
    status: 'CAPTURED',
    netSettledCents: 300,
    commissionCents: 60,
    capturedAt: '2026-07-15T15:00:00Z', // hoy · Lima 10:00
    mode: 'CARPOOLING',
  });
  await seedPayment({
    method: 'YAPE',
    status: 'CAPTURED',
    netSettledCents: 100,
    commissionCents: 0,
    capturedAt: '2026-07-15T17:00:00Z', // hoy · Lima 12:00
    kind: 'TIP', // propina: entra a money-in (netSettled) pero NO es un viaje → fuera de tripCount
  });

  // ── Ruido que NO debe contar ──
  await seedPayment({
    method: 'CASH',
    status: 'CAPTURED',
    netSettledCents: 2000,
    commissionCents: 400,
    capturedAt: '2026-07-15T14:00:00Z', // efectivo: excluido (no entra al banco)
  });
  await seedPayment({
    method: 'YAPE',
    status: 'REFUNDED',
    netSettledCents: 400,
    commissionCents: 80,
    capturedAt: '2026-07-15T14:00:00Z', // reembolsado TOTAL: fuera del cohorte CAPTURED/PARTIALLY_REFUNDED
  });

  // ── Reembolsos (por createdAt · solo COMPLETED cuenta) ──
  await seedRefund({
    paymentId: p1,
    amountCents: 300,
    status: 'COMPLETED',
    createdAt: '2026-07-15T17:00:00Z',
  }); // hoy
  await seedRefund({
    paymentId: p3,
    amountCents: 150,
    status: 'COMPLETED',
    createdAt: '2026-07-05T12:00:00Z',
  }); // 10d → solo 30d
  await seedRefund({
    paymentId: p1,
    amountCents: 999,
    status: 'PENDING',
    createdAt: '2026-07-15T18:00:00Z',
  }); // PENDING → nunca
  await seedRefund({
    paymentId: p4,
    amountCents: 500,
    status: 'COMPLETED',
    createdAt: '2026-06-01T12:00:00Z',
  }); // 40d → fuera de todo
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

describe('AnalyticsService.revenueMetrics · agregación por rango (TZ Lima, money-critical)', () => {
  it('today: money-in + comisión bruta + reembolsos del día; excluye CASH y REFUNDED total; incluye TIP en money-in', async () => {
    const m = await analytics.revenueMetrics(RevenueRange.TODAY, NOW);
    expect(m.moneyInCents).toBe(1900); // P1 1000 + P2 500 + carpool 300 + tip 100 (CASH y REFUNDED fuera)
    expect(m.grossCommissionCents).toBe(360); // 200 + 100 + 60 + 0
    expect(m.refundedCents).toBe(300); // solo R1 COMPLETED de hoy
  });

  it('7d: incorpora el cobro de hace 3 días, aún no los reembolsos de hace 10 días', async () => {
    const m = await analytics.revenueMetrics(RevenueRange.SEVEN_DAYS, NOW);
    expect(m.moneyInCents).toBe(2700); // 1900 + P3 800
    expect(m.grossCommissionCents).toBe(520); // 360 + 160
    expect(m.refundedCents).toBe(300); // R2 (hace 10 días) queda fuera de 7d
  });

  it('30d: incorpora el cobro de hace 20 días y el reembolso de hace 10 días; excluye lo de hace 40 días', async () => {
    const m = await analytics.revenueMetrics(RevenueRange.THIRTY_DAYS, NOW);
    expect(m.moneyInCents).toBe(3400); // 2700 + P4 700 (el de hace 40 días fuera de 30d)
    expect(m.grossCommissionCents).toBe(660); // 520 + 140
    expect(m.refundedCents).toBe(450); // R1 300 + R2 150 (R4 de hace 40 días fuera)
    // Margen que DERIVA el bff = comisión bruta − reembolsos.
    expect(m.grossCommissionCents - m.refundedCents).toBe(210);
  });

  it('tripCount: cuenta cobros FARE del cohorte por rango; el TIP NO cuenta como viaje', async () => {
    const today = await analytics.revenueMetrics(RevenueRange.TODAY, NOW);
    expect(today.tripCount).toBe(3); // P1, P2, carpool (el TIP fuera; CASH/REFUNDED fuera)
    const d7 = await analytics.revenueMetrics(RevenueRange.SEVEN_DAYS, NOW);
    expect(d7.tripCount).toBe(4); // + P3
    const d30 = await analytics.revenueMetrics(RevenueRange.THIRTY_DAYS, NOW);
    expect(d30.tripCount).toBe(5); // + P4
  });

  it('byMode 30d: Σ netSettled por modo (2-way ON_DEMAND | CARPOOLING) reconcilia con money-in', async () => {
    const m = await analytics.revenueMetrics(RevenueRange.THIRTY_DAYS, NOW);
    const byMode = Object.fromEntries(m.byMode.map((x) => [x.mode, x.revenueCents]));
    expect(byMode.ON_DEMAND).toBe(3100); // P1 1000 + P2 500 + tip 100 + P3 800 + P4 700
    expect(byMode.CARPOOLING).toBe(300); // carpool
    const sum = m.byMode.reduce((a, x) => a + x.revenueCents, 0);
    expect(sum).toBe(m.moneyInCents); // 3400
  });

  it('previous 30d: totales de la ventana anterior (el cobro de hace 40 días cae ahí)', async () => {
    const m = await analytics.revenueMetrics(RevenueRange.THIRTY_DAYS, NOW);
    expect(m.previous.moneyInCents).toBe(900); // el cobro de hace 40 días está en [prevStart, since)
    expect(m.previous.tripCount).toBe(1);
  });

  it('90d: el rango actual incorpora el cobro de hace 40 días; sin base previa', async () => {
    const m = await analytics.revenueMetrics(RevenueRange.NINETY_DAYS, NOW);
    expect(m.moneyInCents).toBe(4300); // 3400 + 900 (hace 40 días)
    expect(m.tripCount).toBe(6); // 5 + 1
    expect(m.previous.moneyInCents).toBe(0); // no hay cobros en [since-90d, since)
    expect(m.previous.tripCount).toBe(0);
  });

  it('serie today: buckets por HORA local de Lima, reconcilia EXACTA con moneyInCents', async () => {
    const m = await analytics.revenueMetrics(RevenueRange.TODAY, NOW);
    expect(m.series).toEqual([
      { bucket: '2026-07-15T09:00:00', revenueCents: 1000 }, // P1
      { bucket: '2026-07-15T10:00:00', revenueCents: 300 }, // carpool
      { bucket: '2026-07-15T11:00:00', revenueCents: 500 }, // P2
      { bucket: '2026-07-15T12:00:00', revenueCents: 100 }, // tip
    ]);
    const sum = m.series.reduce((a, p) => a + p.revenueCents, 0);
    expect(sum).toBe(m.moneyInCents);
  });

  it('serie 30d: buckets por DÍA local de Lima, ordenados y reconcilian con el total', async () => {
    const m = await analytics.revenueMetrics(RevenueRange.THIRTY_DAYS, NOW);
    expect(m.series).toEqual([
      { bucket: '2026-06-25', revenueCents: 700 }, // P4
      { bucket: '2026-07-12', revenueCents: 800 }, // P3
      { bucket: '2026-07-15', revenueCents: 1900 }, // hoy (P1+P2+carpool+tip)
    ]);
    const sum = m.series.reduce((a, p) => a + p.revenueCents, 0);
    expect(sum).toBe(m.moneyInCents);
  });
});
