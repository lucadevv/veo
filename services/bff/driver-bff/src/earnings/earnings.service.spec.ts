/** Test de la agregación del resumen de ganancias del conductor (EarningsService). */
import { describe, it, expect, vi } from 'vitest';
import type { AuthenticatedUser } from '@veo/auth';
import type { DriverPayoutView } from '@veo/api-client';
import { EarningsService } from './earnings.service';

const identity: AuthenticatedUser = { userId: 'usr-1', type: 'driver', roles: [], sessionId: 's1' };

function payout(over: Partial<DriverPayoutView>): DriverPayoutView {
  return {
    id: 'p',
    driverId: 'drv-1',
    periodStart: '2026-05-01T00:00:00.000Z',
    periodEnd: '2026-05-07T00:00:00.000Z',
    grossCents: 10000,
    commissionCents: 2000,
    amountCents: 8000,
    currency: 'PEN',
    status: 'PROCESSED',
    processedAt: '2026-05-08T00:00:00.000Z',
    heldReason: null,
    createdAt: '2026-05-07T00:00:00.000Z',
    updatedAt: '2026-05-08T00:00:00.000Z',
    ...over,
  };
}

function makeService(payouts: DriverPayoutView[]) {
  const grpc = {
    call: vi.fn(() => Promise.resolve({ id: 'drv-1', userId: 'usr-1', found: true })),
  };
  const get = vi.fn(() => Promise.resolve(payouts));
  const rest = { client: vi.fn(() => ({ get })) };
  const service = new EarningsService(grpc as never, rest as never);
  return { service, grpc, get };
}

describe('EarningsService.breakdown', () => {
  it('agrega hoy, semana y mes desde payment-service por ventana', async () => {
    const today = {
      grossCents: 4000,
      commissionCents: 800,
      tipCents: 500,
      netCents: 3700,
      tripCount: 3,
    };
    const week = {
      grossCents: 20000,
      commissionCents: 4000,
      tipCents: 1500,
      netCents: 17500,
      tripCount: 12,
    };
    const month = {
      grossCents: 80000,
      commissionCents: 16000,
      tipCents: 6000,
      netCents: 70000,
      tripCount: 48,
    };
    // Discrimina la ventana por su `from`: día (27), semana (25) o mes (01).
    const get = vi.fn((_path: string, opts: { query: { from: string } }) => {
      if (opts.query.from.startsWith('2026-05-27')) return Promise.resolve(today);
      if (opts.query.from.startsWith('2026-05-01')) return Promise.resolve(month);
      return Promise.resolve(week);
    });
    const grpc = {
      call: vi.fn(() => Promise.resolve({ id: 'drv-1', userId: 'usr-1', found: true })),
    };
    const rest = { client: vi.fn(() => ({ get })) };
    const service = new EarningsService(grpc as never, rest as never);

    const summary = await service.breakdown(identity, new Date('2026-05-27T14:30:00.000Z'));
    expect(summary.driverId).toBe('drv-1');
    expect(summary.currency).toBe('PEN');
    expect(summary.today.tipCents).toBe(500);
    expect(summary.today.netCents).toBe(3700);
    expect(summary.week.tipCents).toBe(1500);
    expect(summary.week.tripCount).toBe(12);
    expect(summary.month.netCents).toBe(70000);
    expect(summary.month.tripCount).toBe(48);
    // Las ventanas se pasaron como [from,to) ISO al endpoint de payment, con bordes de día LIMA
    // (medianoche Lima = 05:00Z). La identidad propagada lleva el driverId resuelto y firmado
    // (anti-IDOR aguas abajo).
    expect(get).toHaveBeenCalledWith('/payments/earnings', {
      identity: { ...identity, driverId: 'drv-1' },
      query: {
        driverId: 'drv-1',
        from: '2026-05-27T05:00:00.000Z',
        to: '2026-05-28T05:00:00.000Z',
      },
    });
    // La ventana del mes se pasó como [día 1, día 1 del mes siguiente) en hora de Lima.
    expect(get).toHaveBeenCalledWith('/payments/earnings', {
      identity: { ...identity, driverId: 'drv-1' },
      query: {
        driverId: 'drv-1',
        from: '2026-05-01T05:00:00.000Z',
        to: '2026-06-01T05:00:00.000Z',
      },
    });
  });
});

describe('EarningsService.daily', () => {
  it('devuelve 7 puntos lun→dom con netCents/tripCount por día', async () => {
    // Cada día devuelve un breakdown cuyo net/trip codifica su fecha, para verificar el mapeo.
    const get = vi.fn((_path: string, opts: { query: { from: string } }) => {
      const dom = Number(opts.query.from.slice(8, 10)); // día del mes en el `from`
      return Promise.resolve({
        grossCents: dom * 100,
        commissionCents: dom * 20,
        tipCents: dom * 10,
        netCents: dom * 80,
        tripCount: dom,
      });
    });
    const grpc = {
      call: vi.fn(() => Promise.resolve({ id: 'drv-1', userId: 'usr-1', found: true })),
    };
    const rest = { client: vi.fn(() => ({ get })) };
    const service = new EarningsService(grpc as never, rest as never);

    const series = await service.daily(identity, new Date('2026-05-27T14:30:00.000Z'));
    expect(series.driverId).toBe('drv-1');
    expect(series.currency).toBe('PEN');
    expect(series.days).toHaveLength(7);
    // Semana del lunes 2026-05-25 → domingo 2026-05-31.
    expect(series.days.map((d) => d.date)).toEqual([
      '2026-05-25',
      '2026-05-26',
      '2026-05-27',
      '2026-05-28',
      '2026-05-29',
      '2026-05-30',
      '2026-05-31',
    ]);
    expect(series.days[0]).toEqual({ date: '2026-05-25', netCents: 25 * 80, tripCount: 25 });
    expect(series.days[6]).toEqual({ date: '2026-05-31', netCents: 31 * 80, tripCount: 31 });
    expect(get).toHaveBeenCalledTimes(7);
  });
});

describe('EarningsService.summary', () => {
  it('agrega bruto/comisión/neto y separa pagado de pendiente', async () => {
    const { service, get } = makeService([
      payout({
        id: 'a',
        status: 'PROCESSED',
        grossCents: 10000,
        commissionCents: 2000,
        amountCents: 8000,
      }),
      payout({
        id: 'b',
        status: 'PENDING',
        grossCents: 5000,
        commissionCents: 1000,
        amountCents: 4000,
      }),
    ]);
    const summary = await service.summary(identity);

    expect(summary.driverId).toBe('drv-1');
    expect(summary.currency).toBe('PEN');
    expect(summary.payoutCount).toBe(2);
    expect(summary.totalGrossCents).toBe(15000);
    expect(summary.totalCommissionCents).toBe(3000);
    expect(summary.totalNetCents).toBe(12000);
    expect(summary.paidNetCents).toBe(8000);
    expect(summary.pendingNetCents).toBe(4000);
    expect(summary.payouts).toHaveLength(2);
    // El payouts del downstream se filtró por el driverId resuelto, no por el cliente.
    // La identidad propagada lleva el driverId resuelto y firmado (anti-IDOR aguas abajo).
    expect(get).toHaveBeenCalledWith('/payouts', {
      identity: { ...identity, driverId: 'drv-1' },
      query: { driverId: 'drv-1' },
    });
  });

  it('devuelve ceros y PEN por defecto sin payouts', async () => {
    const { service } = makeService([]);
    const summary = await service.summary(identity);
    expect(summary.payoutCount).toBe(0);
    expect(summary.totalNetCents).toBe(0);
    expect(summary.pendingNetCents).toBe(0);
    expect(summary.currency).toBe('PEN');
  });
});
