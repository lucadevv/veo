/**
 * charge() · comisión por MODO (F2.7 · ADR-017 §1.6 / ADR-015 §11.2 · camino de DINERO). Verifica END-TO-END
 * en el service que:
 *  - el cobro CARPOOLING SUMA el service fee al pasajero (grossCents cobrado = contribución + fee), el corte de
 *    la plataforma es el fee y el conductor cobra el 100% de su contribución;
 *  - el cobro ON_DEMAND DESCUENTA la comisión al conductor con la tasa CONFIGURADA y persiste `mode=ON_DEMAND`;
 *  - sin CommissionService inyectado, el ON_DEMAND DEGRADA a la tasa del env y el CARPOOLING cae a fee 0 — NUNCA
 *    rompe el cobro.
 * Se usa el método CASH (no toca gateway: charge() devuelve el Payment recién creado tras persistir).
 */
import { describe, it, expect, vi } from 'vitest';
import { PaymentsService } from './payments.service';
import { ChargeMode } from './payment.policy';
import type { CommissionService } from '../commission/commission.service';

/** Captura el `data` del payment.create y lo devuelve como la fila creada (status PENDING). */
function buildService(opts: { commission?: Partial<CommissionService>; envRate?: number } = {}) {
  const created: Record<string, unknown>[] = [];
  // Mock del PaymentsRepository: charge() lee por dedupKey (idempotencia, null) y persiste el Payment.
  const repo = {
    findPaymentByDedupKey: vi.fn(async () => null),
    createPayment: vi.fn(async (data: Record<string, unknown>) => {
      created.push(data);
      return { ...data };
    }),
  };
  // Solo COMMISSION_RATE importa para la comisión; el resto del ctor lee números que no afectan este camino.
  const config = {
    getOrThrow: (k: string) => (k === 'COMMISSION_RATE' ? (opts.envRate ?? 0.2) : 0),
  };
  const service = new PaymentsService(
    repo as never,
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
  it('CARPOOLING → el service fee se SUMA al pasajero; el conductor cobra FULL (contribución 2000, fee 15%)', async () => {
    const commission = {
      resolveRateBps: vi.fn(async (mode: ChargeMode) =>
        mode === ChargeMode.CARPOOLING ? 1500 : 2000,
      ),
    };
    const { service, created } = buildService({ commission });
    const payment = await service.charge({
      tripId: 'b-1',
      grossCents: 2000, // la CONTRIBUCIÓN del conductor (cost-sharing)
      method: 'CASH',
      dedupKey: 'booking-charge:b-1',
      mode: ChargeMode.CARPOOLING,
    });
    expect(commission.resolveRateBps).toHaveBeenCalledWith(ChargeMode.CARPOOLING);
    expect(payment.commissionCents).toBe(300); // fee = 15% de 2000 (corte de la plataforma)
    expect(created[0]!.mode).toBe('CARPOOLING');
    expect(created[0]!.grossCents).toBe(2300); // COBRADO al pasajero = contribución + fee
    expect(created[0]!.amountCents).toBe(2300); // lo que se cobra al método de pago del pasajero
    expect(created[0]!.commissionCents).toBe(300);
    expect(created[0]!.feeCents).toBe(300);
    // driverNet derivable: gross − commission = 2300 − 300 = 2000 (contribución FULL al conductor).
    expect((created[0]!.grossCents as number) - (created[0]!.commissionCents as number)).toBe(2000);
  });

  it('CARPOOLING sin CommissionService → fee 0: el pasajero paga exactamente la contribución, conductor FULL', async () => {
    const { service, created } = buildService(); // sin commission inyectado → carpooling fee 0
    await service.charge({
      tripId: 'b-2',
      grossCents: 3000,
      method: 'CASH',
      dedupKey: 'booking-charge:b-2',
      mode: ChargeMode.CARPOOLING,
    });
    expect(created[0]!.commissionCents).toBe(0);
    expect(created[0]!.grossCents).toBe(3000); // contribución + 0
    expect(created[0]!.amountCents).toBe(3000);
  });

  it('ON_DEMAND → usa la tasa CONFIGURADA (15%) y persiste mode=ON_DEMAND', async () => {
    const commission = {
      resolveRateBps: vi.fn(async (mode: ChargeMode) =>
        mode === ChargeMode.CARPOOLING ? 0 : 1500,
      ),
    };
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
