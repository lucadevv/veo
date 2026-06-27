/**
 * charge() · comisión por MODO (F2.7 · ADR-017 §1.6 / ADR-015 §11.2 · camino de DINERO). Verifica END-TO-END
 * en el service que:
 *  - el cobro CARPOOLING persiste comisión 0 y `mode=CARPOOLING` AUNQUE haya una tasa on-demand configurada
 *    alta (el GUARD LEGAL no se puede saltar desde el cobro);
 *  - el cobro ON_DEMAND persiste la tasa CONFIGURADA (CommissionService) y `mode=ON_DEMAND`;
 *  - sin CommissionService inyectado, el ON_DEMAND DEGRADA a la tasa del env — NUNCA rompe el cobro.
 * Se usa el método CASH (no toca gateway: charge() devuelve el Payment recién creado tras persistir).
 */
import { describe, it, expect, vi } from 'vitest';
import { PaymentsService } from './payments.service';
import { ChargeMode } from './payment.policy';
import type { CommissionService } from '../commission/commission.service';

/** Captura el `data` del payment.create y lo devuelve como la fila creada (status PENDING). */
function buildService(opts: { commission?: Partial<CommissionService>; envRate?: number } = {}) {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    read: { payment: { findUnique: vi.fn(async () => null) } },
    write: {
      payment: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { ...data };
        }),
      },
    },
  };
  // Solo COMMISSION_RATE importa para la comisión; el resto del ctor lee números que no afectan este camino.
  const config = { getOrThrow: (k: string) => (k === 'COMMISSION_RATE' ? (opts.envRate ?? 0.2) : 0) };
  const service = new PaymentsService(
    prisma as never,
    {} as never, // gateway: CASH no lo toca
    {} as never, // affiliations
    {} as never, // promotions
    config as never,
    undefined, // credit
    undefined, // metrics
    opts.commission as never, // commission (puede faltar → degradación al env)
  );
  return { service, created };
}

describe('charge() · comisión por modo (camino de dinero + legal)', () => {
  it('CARPOOLING → comisión 0 y mode=CARPOOLING, AUNQUE la config on-demand sea 20% (guard legal)', async () => {
    // El stub devolvería 20% para on-demand; el carpooling igual debe terminar en 0 (resolveChargeRate corta antes).
    const commission = { resolveRateBps: vi.fn(async () => 2000) };
    const { service, created } = buildService({ commission });
    const payment = await service.charge({
      tripId: 'b-1',
      grossCents: 3000,
      method: 'CASH',
      dedupKey: 'booking-charge:b-1',
      mode: ChargeMode.CARPOOLING,
    });
    expect(payment.commissionCents).toBe(0);
    expect(commission.resolveRateBps).not.toHaveBeenCalled(); // resolveChargeRate corta antes de consultar config
    expect(created[0]!.mode).toBe('CARPOOLING');
    expect(created[0]!.commissionCents).toBe(0);
    expect(created[0]!.feeCents).toBe(0);
  });

  it('ON_DEMAND → usa la tasa CONFIGURADA (15%) y persiste mode=ON_DEMAND', async () => {
    const commission = { resolveRateBps: vi.fn(async (mode: ChargeMode) => (mode === ChargeMode.CARPOOLING ? 0 : 1500)) };
    const { service, created } = buildService({ commission });
    await service.charge({
      tripId: 't-1',
      grossCents: 2000,
      method: 'CASH',
      dedupKey: 'trip-completed:t-1',
      mode: ChargeMode.ON_DEMAND,
    });
    expect(created[0]!.commissionCents).toBe(300); // 15% de 2000
    expect(created[0]!.mode).toBe('ON_DEMAND');
  });

  it('ON_DEMAND sin CommissionService → DEGRADA a la tasa del env (20%), NUNCA rompe el cobro', async () => {
    const { service, created } = buildService({ envRate: 0.2 }); // sin commission inyectado
    await service.charge({
      tripId: 't-2',
      grossCents: 2000,
      method: 'CASH',
      dedupKey: 'trip-completed:t-2',
      mode: ChargeMode.ON_DEMAND,
    });
    expect(created[0]!.commissionCents).toBe(400); // 20% de 2000 (env fallback)
    expect(created[0]!.mode).toBe('ON_DEMAND');
  });

  it('sin mode explícito → ON_DEMAND por defecto (jamás CARPOOLING) — compat conservadora', async () => {
    const { service, created } = buildService({ envRate: 0.2 });
    await service.charge({
      tripId: 't-3',
      grossCents: 1000,
      method: 'CASH',
      dedupKey: 'd-3',
    });
    expect(created[0]!.mode).toBe('ON_DEMAND');
    expect(created[0]!.commissionCents).toBe(200); // 20%, no 0
  });
});
