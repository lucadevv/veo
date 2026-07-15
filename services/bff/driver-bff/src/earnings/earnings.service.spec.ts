/** Test de la agregación del resumen de ganancias del conductor (EarningsService). */
import { describe, it, expect, vi } from 'vitest';
import type { AuthenticatedUser } from '@veo/auth';
import type { DriverPayoutView } from '@veo/api-client';
import { settleDriverDebtView } from '@veo/api-client';
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

/** Balance pendiente que payment-service serviría por el riel driver (todo en 0 por defecto). */
const ZERO_BALANCE = { openNetCents: 0, pendingDebtCents: 0, pendingCreditCents: 0 };

function makeService(
  payouts: DriverPayoutView[],
  balance: typeof ZERO_BALANCE = ZERO_BALANCE,
) {
  const grpc = {
    call: vi.fn(() => Promise.resolve({ id: 'drv-1', userId: 'usr-1', found: true })),
  };
  // El summary pega a DOS lecturas: /payouts (filas agregadas) y el balance pendiente driver-rail.
  const get = vi.fn((path: string) =>
    path === '/payouts' ? Promise.resolve(payouts) : Promise.resolve(balance),
  );
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

  // ── "Por liquidar" honesto: pendingNet = max(0, abierto + payouts no pagados + crédito − deuda) ──

  it('SIN payouts pero con devengado digital abierto → pendiente > 0 (ya no S/0 toda la semana)', async () => {
    const { service, get } = makeService([], {
      openNetCents: 18_700, // S/187 digitales de la semana abierta (aún sin fila Payout)
      pendingDebtCents: 0,
      pendingCreditCents: 0,
    });
    const summary = await service.summary(identity);
    expect(summary.pendingNetCents).toBe(18_700);
    expect(summary.openNetCents).toBe(18_700);
    expect(summary.pendingDebtCents).toBe(0);
    // El balance se pidió al endpoint mínimo driver-rail, con la identidad firmada (anti-IDOR aguas abajo).
    expect(get).toHaveBeenCalledWith('/internal/finance/driver-balance/pending', {
      identity: { ...identity, driverId: 'drv-1' },
      query: { driverId: 'drv-1' },
    });
  });

  it('la deuda CASH PENDING resta del pendiente (y se expone en pendingDebtCents)', async () => {
    const { service } = makeService([], {
      openNetCents: 18_700,
      pendingDebtCents: 804, // S/8.04 de comisión de viajes en efectivo
      pendingCreditCents: 0,
    });
    const summary = await service.summary(identity);
    expect(summary.pendingNetCents).toBe(18_700 - 804);
    expect(summary.pendingDebtCents).toBe(804);
  });

  it('el crédito PENDING suma; los payouts NO pagados (PENDING) también entran a la fórmula', async () => {
    const { service } = makeService(
      [payout({ id: 'b', status: 'PENDING', amountCents: 4000 })],
      { openNetCents: 1000, pendingDebtCents: 300, pendingCreditCents: 200 },
    );
    const summary = await service.summary(identity);
    // 1000 (abierto) + 4000 (payout PENDING) + 200 (crédito) − 300 (deuda) = 4900.
    expect(summary.pendingNetCents).toBe(4900);
  });

  it('piso 0: si la deuda supera todo, el pendiente NO es negativo (carry-forward, no se le cobra)', async () => {
    const { service } = makeService([], {
      openNetCents: 500,
      pendingDebtCents: 804,
      pendingCreditCents: 0,
    });
    const summary = await service.summary(identity);
    expect(summary.pendingNetCents).toBe(0);
    expect(summary.pendingDebtCents).toBe(804); // la deuda sigue visible aparte (fila "Debés a VEO")
  });

  it('los payouts pasan tal cual con su debtAppliedCents (el neteo que explica gross − comisión ≠ monto)', async () => {
    const netted = payout({
      id: 'n',
      status: 'PROCESSED',
      grossCents: 10_000,
      commissionCents: 2000,
      amountCents: 7196, // 8000 − 804 de deuda neteada
      debtAppliedCents: 804,
    });
    const { service } = makeService([netted]);
    const summary = await service.summary(identity);
    expect(summary.payouts[0]?.debtAppliedCents).toBe(804);
  });
});

describe('EarningsService.commissionRate', () => {
  const rate = { onDemandRateBps: 2000, version: 3 };

  function makeRateService() {
    const grpc = { call: vi.fn() };
    const get = vi.fn(() => Promise.resolve(rate));
    const rest = { client: vi.fn(() => ({ get })) };
    const service = new EarningsService(grpc as never, rest as never);
    return { service, grpc, get };
  }

  it('lee la tasa vigente del endpoint mínimo driver-rail de payment (sin resolver driverId)', async () => {
    const { service, grpc, get } = makeRateService();
    const view = await service.commissionRate(identity, 1_000);
    expect(view).toEqual({ onDemandRateBps: 2000, version: 3 });
    expect(get).toHaveBeenCalledWith('/internal/finance/commission/on-demand-rate', { identity });
    // Config global: NO se resuelve el driverId por gRPC (no es un recurso del conductor).
    expect(grpc.call).not.toHaveBeenCalled();
  });

  it('cachea 60 s: dentro del TTL no re-consulta; vencido, refetchea', async () => {
    const { service, get } = makeRateService();
    await service.commissionRate(identity, 1_000);
    await service.commissionRate(identity, 60_000); // < 1_000 + 60_000 → cache
    expect(get).toHaveBeenCalledTimes(1);
    await service.commissionRate(identity, 61_001); // TTL vencido → refetch
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('EarningsService.settleDebt', () => {
  it('normaliza el Payment CRUDO de payment (externalRef null → "") y conserva el checkout de Yape', async () => {
    // Shape REAL de payment-service: la fila Prisma serializada trae `externalRef: null` mientras el
    // checkout está PENDING (el capture ref recién existe al capturar) y los campos opcionales como null,
    // no "". Sin normalizar, el `paymentView.parse()` del app LANZA sobre `externalRef` (z.string()
    // no-nullable) → el conductor ve "No pudimos iniciar el pago" aunque el cobro trae checkout.
    const settlementPayment = {
      id: 'pay-settle-1',
      tripId: 'trip-9',
      method: 'YAPE',
      status: 'PENDING' as const,
      amountCents: 10000,
      grossCents: 10000,
      tipCents: 0,
      commissionCents: 0,
      feeCents: 0,
      externalRef: null,
      externalUid: 'sbx_yape_pay-settle-1',
      checkoutUrl: 'https://sandbox.local/pay/sbx_yape_pay-settle-1',
      qrCode: 'data:image/png;base64,c2J4X3lhcGU=',
      deepLink: null,
      cip: null,
      checkoutExpiresAt: '2026-05-27T15:00:00.000Z',
      failureReason: null,
    };
    const grpc = {
      call: vi.fn(() => Promise.resolve({ id: 'drv-1', userId: 'usr-1', found: true })),
    };
    const post = vi.fn(() => Promise.resolve(settlementPayment));
    const rest = { client: vi.fn(() => ({ post })) };
    const service = new EarningsService(grpc as never, rest as never);

    const result = await service.settleDebt(identity, { method: 'YAPE', payerRef: '999888777' });

    // externalRef nulo → "" (contrato del app: string no-nullable). El checkout se conserva de punta a
    // punta (externalUid/checkoutUrl/qrCode) para que el app abra el QR/urlPay de Yape y pollee la captura.
    expect(result).toEqual({
      id: 'pay-settle-1',
      tripId: 'trip-9',
      method: 'YAPE',
      status: 'PENDING',
      amountCents: 10000,
      grossCents: 10000,
      tipCents: 0,
      commissionCents: 0,
      feeCents: 0,
      externalRef: '',
      externalUid: 'sbx_yape_pay-settle-1',
      checkoutUrl: 'https://sandbox.local/pay/sbx_yape_pay-settle-1',
      qrCode: 'data:image/png;base64,c2J4X3lhcGU=',
      deepLink: null,
      cip: null,
      checkoutExpiresAt: '2026-05-27T15:00:00.000Z',
      failureReason: null,
    });
    // El resultado DEBE parsear contra el contrato soberano del app (lo que el HttpClient hace en el device).
    expect(() => settleDriverDebtView.parse(result)).not.toThrow();
    // El driverId NO viene del cliente: se resuelve por gRPC y se FIRMA en la identidad + viaja en el body
    // (payment lo revalida contra la identidad firmada → anti-IDOR).
    expect(post).toHaveBeenCalledWith('/internal/finance/driver-debt/settle', {
      identity: { ...identity, driverId: 'drv-1' },
      body: { driverId: 'drv-1', method: 'YAPE', payerRef: '999888777' },
    });
  });

  it('propaga el error de payment (409 sin deuda / 422 CASH) sin envolverlo', async () => {
    const boom = new Error('No tenés deuda de comisiones pendiente por saldar');
    const grpc = {
      call: vi.fn(() => Promise.resolve({ id: 'drv-1', userId: 'usr-1', found: true })),
    };
    const post = vi.fn(() => Promise.reject(boom));
    const rest = { client: vi.fn(() => ({ post })) };
    const service = new EarningsService(grpc as never, rest as never);

    await expect(service.settleDebt(identity, { method: 'PLIN' })).rejects.toBe(boom);
  });
});
