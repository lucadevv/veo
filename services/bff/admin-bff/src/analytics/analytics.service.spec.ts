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
      series: [{ bucket: '2026-07-15', revenueCents: 3000 }],
    }));

    const view = await svc.revenue(IDENTITY, '30d');

    expect(view).toEqual({
      range: '30d',
      moneyInCents: 3000,
      grossCommissionCents: 600,
      refundedCents: 450,
      platformMarginCents: 150, // 600 − 450, derivado por el bff
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
      series: [],
    });
  });
});
