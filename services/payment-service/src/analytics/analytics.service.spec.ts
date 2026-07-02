/**
 * P-B (ADR-022 · gate) · Los KPIs de "money-in al banco" DEBEN excluir CASH (el efectivo lo cobra el conductor en
 * mano, nunca llega al banco de VEO) y usar el NETO (netSettledCents = bruto − fee PSP), no el bruto. El margen
 * real resta el fee PSP + promo + crédito absorbidos. Se verifica el `where`/`_sum` de las queries agregadas.
 */
import { describe, it, expect, vi } from 'vitest';
import { AnalyticsService } from './analytics.service';

type AggArgs = { _sum: Record<string, boolean>; where: Record<string, unknown> };

function buildService(sums: Record<string, number>) {
  const calls: AggArgs[] = [];
  const prisma = {
    read: {
      payment: {
        aggregate: vi.fn(async (args: AggArgs) => {
          calls.push(args);
          return { _sum: sums };
        }),
        // revenuePerHour usa $queryRaw; no se ejercita acá (se testea el where de los agregados).
      },
      $queryRaw: vi.fn(async () => []),
    },
  };
  return { svc: new AnalyticsService(prisma as never), calls };
}

describe('P-B · analytics money-in al banco (excluye CASH, net-aware)', () => {
  it('revenueToday: usa netSettledCents − refundedCents, EXCLUYE CASH, incluye PARTIALLY_REFUNDED', async () => {
    const { svc, calls } = buildService({ netSettledCents: 9650, refundedCents: 150 });
    const out = await svc.revenue(new Date('2026-07-02T18:00:00Z'));
    expect(out.revenueTodayCents).toBe(9650 - 150); // neto − reembolsado
    const revenueCall = calls[0]!;
    expect(revenueCall._sum).toMatchObject({ netSettledCents: true, refundedCents: true });
    expect(revenueCall.where.method).toEqual({ not: 'CASH' }); // el efectivo NO llega al banco
    expect(revenueCall.where.status).toEqual({ in: ['CAPTURED', 'PARTIALLY_REFUNDED'] });
  });

  it('platformMarginToday: comisión − fee PSP − promo − crédito, EXCLUYE CASH', async () => {
    const { svc, calls } = buildService({
      commissionCents: 2000,
      pspFeeCents: 350,
      discountCents: 100,
      creditCents: 50,
    });
    const out = await svc.revenue(new Date('2026-07-02T18:00:00Z'));
    expect(out.platformMarginTodayCents).toBe(2000 - 350 - 100 - 50);
    const marginCall = calls[1]!; // 2da query agregada
    expect(marginCall.where.method).toEqual({ not: 'CASH' });
  });
});
