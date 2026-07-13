/**
 * Unit del AnalyticsService (bff) para la pantalla "Métricas": arma la view de revenue por rango llamando el
 * interno HMAC de payment-service. Verifica (1) el shape de la view + el DERIVE del margen (comisión − reembolsos),
 * (2) que echoa el rango pedido, (3) la degradación HONESTA si payment-service no responde (todo 0 / [] , margen 0).
 */
import { describe, it, expect, vi } from 'vitest';
import type { InternalRestClient } from '@veo/rpc';
import type { Logger } from '@veo/observability';
import type { AuthenticatedUser } from '@veo/auth';
import { AnalyticsService } from './analytics.service';

const IDENTITY = { id: 'op-1', roles: ['ADMIN'] } as unknown as AuthenticatedUser;

function buildService(paymentGet: () => Promise<unknown>) {
  const paymentRest = { get: vi.fn(paymentGet) } as unknown as InternalRestClient;
  const stub = {} as unknown as InternalRestClient;
  const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
  const svc = new AnalyticsService(stub, stub, stub, paymentRest, logger);
  return { svc, paymentRest };
}

describe('AnalyticsService.revenue (bff) · view de revenue por rango', () => {
  it('arma la view, DERIVA platformMarginCents = comisión − reembolsos y echoa el rango', async () => {
    const { svc, paymentRest } = buildService(async () => ({
      moneyInCents: 3000,
      grossCommissionCents: 600,
      refundedCents: 450,
      tripCount: 100,
      byMode: [{ mode: 'ON_DEMAND', revenueCents: 3000 }],
      topDistricts: [{ district: 'Miraflores', revenueCents: 1800 }],
      previous: { moneyInCents: 2000, tripCount: 80 },
      series: [{ bucket: '2026-07-15', revenueCents: 3000 }],
    }));

    const view = await svc.revenue(IDENTITY, '30d');

    expect(view).toEqual({
      range: '30d',
      moneyInCents: 3000,
      grossCommissionCents: 600,
      refundedCents: 450,
      platformMarginCents: 150, // 600 − 450, derivado por el bff
      tripCount: 100,
      avgTicketCents: 30, // round(3000 / 100)
      byMode: [{ mode: 'ON_DEMAND', revenueCents: 3000 }],
      topDistricts: [{ district: 'Miraflores', revenueCents: 1800 }], // passthrough del zonificado de payment
      deltas: {
        moneyInPct: 0.5, // (3000 − 2000) / 2000
        tripCountPct: 0.25, // (100 − 80) / 80
        avgTicketPct: 0.2, // (30 − 25) / 25 (prev avg = 2000/80)
      },
      series: [{ bucket: '2026-07-15', revenueCents: 3000 }],
    });
    // Llama al interno correcto con el rango en el query (HMAC · identity propagada).
    expect(paymentRest.get).toHaveBeenCalledWith(
      '/internal/analytics/revenue-metrics',
      expect.objectContaining({ identity: IDENTITY, query: { range: '30d' } }),
    );
  });

  it('degradación honesta: si payment-service falla, todo cae a 0 / [] y el margen a 0', async () => {
    const { svc } = buildService(async () => {
      throw new Error('payment-service caído');
    });

    const view = await svc.revenue(IDENTITY, 'today');

    expect(view).toEqual({
      range: 'today',
      moneyInCents: 0,
      grossCommissionCents: 0,
      refundedCents: 0,
      platformMarginCents: 0,
      tripCount: 0,
      avgTicketCents: 0,
      byMode: [],
      topDistricts: [],
      deltas: { moneyInPct: null, tripCountPct: null, avgTicketPct: null },
      series: [],
    });
  });
});

describe('AnalyticsService.overview (bff) · KPIs de hoy (derivados + passthrough del margen/viajes)', () => {
  /** InternalRestClient fake: `get` resuelve el reply (o lanza, para el caso degradado de payment). */
  function rest(reply: unknown, throws = false): InternalRestClient {
    return {
      get: vi.fn(async () => {
        if (throws) throw new Error('down');
        return reply;
      }),
    } as unknown as InternalRestClient;
  }
  const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;

  it('deriva avgTicketTodayCents (round) y cancellationRateToday; reenvía margen y viajes de hoy', async () => {
    const trip = rest({
      activeTrips: 2,
      completedToday: 8,
      cancelledToday: 2,
      avgDurationSeconds: 600,
      tripsPerHour: [],
    });
    const payment = rest({
      revenueTodayCents: 13500,
      platformMarginTodayCents: 2700,
      tripCountToday: 4,
      byMode: [
        { mode: 'FIXED', trips: 2 },
        { mode: 'PUJA', trips: 1 },
        { mode: 'CARPOOLING', trips: 1 },
      ],
      revenuePerHour: [],
    });
    const svc = new AnalyticsService(
      trip,
      rest({ onlineDrivers: 5 }),
      rest({ openPanics: 1 }),
      payment,
      logger,
    );

    const out = await svc.overview(IDENTITY);

    expect(out.revenueTodayCents).toBe(13500);
    expect(out.platformMarginTodayCents).toBe(2700); // reenviado (antes se dropeaba)
    expect(out.tripCountToday).toBe(4);
    expect(out.avgTicketTodayCents).toBe(3375); // round(13500 / 4)
    expect(out.cancellationRateToday).toBeCloseTo(0.2); // 2 / (8 + 2)
    expect(out.byMode).toEqual([
      { mode: 'FIXED', trips: 2 },
      { mode: 'PUJA', trips: 1 },
      { mode: 'CARPOOLING', trips: 1 },
    ]); // passthrough del desglose por modo de payment (donut)
  });

  it('degradación honesta: payment caído → margen/viajes/ticket 0; sin cierres → cancelación null', async () => {
    const trip = rest({
      activeTrips: 0,
      completedToday: 0,
      cancelledToday: 0,
      avgDurationSeconds: null,
      tripsPerHour: [],
    });
    const svc = new AnalyticsService(
      trip,
      rest({ onlineDrivers: 0 }),
      rest({ openPanics: 0 }),
      rest(null, true),
      logger,
    );

    const out = await svc.overview(IDENTITY);

    expect(out.platformMarginTodayCents).toBe(0);
    expect(out.tripCountToday).toBe(0);
    expect(out.avgTicketTodayCents).toBe(0); // sin viajes → no divide por 0
    expect(out.cancellationRateToday).toBeNull(); // sin cierres hoy
    expect(out.byMode).toEqual([]); // payment caído → donut sin data (no inventado)
  });
});
