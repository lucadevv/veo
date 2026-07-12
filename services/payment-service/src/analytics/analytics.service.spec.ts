/**
 * P-B (ADR-022 · gate) · Los KPIs de "money-in al banco" DEBEN excluir CASH (el efectivo lo cobra el conductor en
 * mano, nunca llega al banco de VEO) y usar el NETO (netSettledCents = bruto − fee PSP), no el bruto. El margen
 * real resta el fee PSP + promo + crédito absorbidos.
 *
 * Se MOCKEA EL REPO (seam de acceso a datos), no Prisma: el COHORTE de la query (excluye CASH, índice
 * [method, status, capturedAt], estados CAPTURED/PARTIALLY_REFUNDED) es un INVARIANTE del repo, verificado por el
 * e2e contra Postgres real (analytics-revenue.e2e.spec.ts). Acá se verifica la FÓRMULA de negocio que compone el
 * service a partir de los componentes que el repo devuelve.
 */
import { describe, it, expect, vi } from 'vitest';
import { AnalyticsService } from './analytics.service';
import type { AnalyticsRepository } from './analytics.repository';

/** Repo fake: devuelve los componentes de suma configurados; el service compone la fórmula del KPI. */
function buildService(over: {
  margin?: {
    commissionCents: number;
    pspFeeCents: number;
    discountCents: number;
    creditCents: number;
  };
  moneyIn?: { netSettledCents: number; refundedCents: number };
  tripCountToday?: number;
}) {
  const repo = {
    sumMoneyInComponentsSince: vi.fn(
      async () => over.moneyIn ?? { netSettledCents: 0, refundedCents: 0 },
    ),
    sumMarginComponentsSince: vi.fn(
      async () =>
        over.margin ?? {
          commissionCents: 0,
          pspFeeCents: 0,
          discountCents: 0,
          creditCents: 0,
        },
    ),
    countFareTripsSince: vi.fn(async () => over.tripCountToday ?? 0),
    revenuePerHourBuckets: vi.fn(async () => []),
  };
  return { svc: new AnalyticsService(repo as unknown as AnalyticsRepository), repo };
}

describe('P-B · analytics money-in al banco (excluye CASH, net-aware)', () => {
  it('revenueToday: compone netSettledCents − refundedCents (incluye PARTIALLY_REFUNDED vía el cohorte del repo)', async () => {
    const { svc } = buildService({ moneyIn: { netSettledCents: 9650, refundedCents: 150 } });
    const out = await svc.revenue(new Date('2026-07-02T18:00:00Z'));
    expect(out.revenueTodayCents).toBe(9650 - 150); // neto − reembolsado
  });

  it('platformMarginToday: compone comisión − fee PSP − promo − crédito', async () => {
    const { svc } = buildService({
      margin: {
        commissionCents: 2000,
        pspFeeCents: 350,
        discountCents: 100,
        creditCents: 50,
      },
    });
    const out = await svc.revenue(new Date('2026-07-02T18:00:00Z'));
    expect(out.platformMarginTodayCents).toBe(2000 - 350 - 100 - 50);
  });

  it('tripCountToday: expone el conteo de viajes FARE de hoy (del repo · KPI "Viajes hoy")', async () => {
    const { svc } = buildService({ tripCountToday: 7 });
    const out = await svc.revenue(new Date('2026-07-02T18:00:00Z'));
    expect(out.tripCountToday).toBe(7);
  });
});
