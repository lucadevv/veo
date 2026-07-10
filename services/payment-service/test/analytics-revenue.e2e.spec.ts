/**
 * E2E con Postgres REAL (testcontainers) — las métricas de revenue de la pantalla "Métricas" del admin son
 * MONEY-CRITICAL: money-in al banco, comisión bruta, reembolsos y margen alimentan decisiones de negocio. Sin
 * mock de DB (CLAUDE: el dinero no se mockea). Verifica la agregación PROPIA de payment-service:
 *  - money-in = Σ netSettledCents de DIGITALES CAPTURED/PARTIALLY_REFUNDED (excluye CASH y REFUNDED totales),
 *  - comisión bruta = Σ commissionCents del MISMO cohorte,
 *  - reembolsos = Σ Refund.amountCents COMPLETED (por createdAt, incluye parciales+totales),
 *  - los límites de rango en TZ America/Lima (today vs 7d vs 30d),
 *  - la serie por bucket (hora en today, día en 7d/30d) reconcilia EXACTA con moneyInCents.
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

async function seedPayment(args: {
  method: Method;
  status: Status;
  netSettledCents: number | null;
  commissionCents: number;
  capturedAt: string;
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

  // ── Cobros digitales (cohorte de money-in + comisión) ──
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
    capturedAt: '2026-07-12T15:00:00Z', // hace 3 días · dentro de 7d/30d
  });
  const p4 = await seedPayment({
    method: 'YAPE',
    status: 'CAPTURED',
    netSettledCents: 700,
    commissionCents: 140,
    capturedAt: '2026-06-25T15:00:00Z', // hace 20 días · solo dentro de 30d
  });
  await seedPayment({
    method: 'YAPE',
    status: 'CAPTURED',
    netSettledCents: 900,
    commissionCents: 180,
    capturedAt: '2026-06-05T15:00:00Z', // hace 40 días · FUERA de todos los rangos
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
  it('today: money-in + comisión bruta + reembolsos del día; excluye CASH y REFUNDED total', async () => {
    const m = await analytics.revenueMetrics(RevenueRange.TODAY, NOW);
    expect(m.moneyInCents).toBe(1500); // P1 1000 + P2 500 (CASH y REFUNDED fuera)
    expect(m.grossCommissionCents).toBe(300); // 200 + 100
    expect(m.refundedCents).toBe(300); // solo R1 COMPLETED de hoy (R2 es de hace 10 días, R3 PENDING)
  });

  it('7d: incorpora el cobro de hace 3 días, aún no los reembolsos de hace 10 días', async () => {
    const m = await analytics.revenueMetrics(RevenueRange.SEVEN_DAYS, NOW);
    expect(m.moneyInCents).toBe(2300); // 1500 + P3 800
    expect(m.grossCommissionCents).toBe(460); // 300 + 160
    expect(m.refundedCents).toBe(300); // R2 (hace 10 días) queda fuera de 7d
  });

  it('30d: incorpora el cobro de hace 20 días y el reembolso de hace 10 días; excluye lo de hace 40 días', async () => {
    const m = await analytics.revenueMetrics(RevenueRange.THIRTY_DAYS, NOW);
    expect(m.moneyInCents).toBe(3000); // 2300 + P4 700 (P5 de hace 40 días fuera)
    expect(m.grossCommissionCents).toBe(600); // 460 + 140
    expect(m.refundedCents).toBe(450); // R1 300 + R2 150 (R4 de hace 40 días fuera)
    // Margen que DERIVA el bff = comisión bruta − reembolsos.
    expect(m.grossCommissionCents - m.refundedCents).toBe(150);
  });

  it('serie today: buckets por HORA local de Lima, reconcilia EXACTA con moneyInCents', async () => {
    const m = await analytics.revenueMetrics(RevenueRange.TODAY, NOW);
    expect(m.series).toEqual([
      { bucket: '2026-07-15T09:00:00', revenueCents: 1000 },
      { bucket: '2026-07-15T11:00:00', revenueCents: 500 },
    ]);
    const sum = m.series.reduce((a, p) => a + p.revenueCents, 0);
    expect(sum).toBe(m.moneyInCents);
  });

  it('serie 30d: buckets por DÍA local de Lima, ordenados y reconcilian con el total', async () => {
    const m = await analytics.revenueMetrics(RevenueRange.THIRTY_DAYS, NOW);
    expect(m.series).toEqual([
      { bucket: '2026-06-25', revenueCents: 700 },
      { bucket: '2026-07-12', revenueCents: 800 },
      { bucket: '2026-07-15', revenueCents: 1500 },
    ]);
    const sum = m.series.reduce((a, p) => a + p.revenueCents, 0);
    expect(sum).toBe(m.moneyInCents);
  });
});
