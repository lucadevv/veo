import { describe, it, expect } from 'vitest';
import { InvalidStateError } from '@veo/utils';
import {
  assertCanAddTip,
  assertPaymentTransition,
  bpsToRate,
  BPS_DENOMINATOR,
  canAddTip,
  canTransitionPayment,
  ChargeMode,
  computeChargeAmounts,
  deriveTripChargeDedupKey,
  resolveCommissionBps,
  retryDelayMs,
} from './payment.policy';

describe('computeChargeAmounts · ON_DEMAND — comisión DESCONTADA al conductor (BR-P04)', () => {
  it('aplica el 20% sobre la tarifa (bruto) y excluye la propina', () => {
    // Tarifa S/20.00 = 2000 céntimos, propina S/3.00 = 300, rate 0.2.
    const r = computeChargeAmounts(ChargeMode.ON_DEMAND, 2000, 300, 0.2);
    expect(r.grossCents).toBe(2000); // bruto cobrado = la tarifa (input)
    expect(r.commissionCents).toBe(400); // 20% de 2000, descontado al conductor
    expect(r.feeCents).toBe(400); // fee visible = comisión
    expect(r.amountCents).toBe(2300); // tarifa + propina cobradas al pasajero
    expect(r.driverNetCents).toBe(1900); // (2000 - 400) + 300
  });

  it('redondea la comisión a céntimos enteros', () => {
    // 20% de 1503 = 300.6 → 301.
    const r = computeChargeAmounts(ChargeMode.ON_DEMAND, 1503, 0, 0.2);
    expect(r.commissionCents).toBe(301);
    expect(r.amountCents).toBe(1503);
    expect(r.driverNetCents).toBe(1202);
  });

  it('una tarifa con surge (mayor bruto) paga más comisión, propina intacta', () => {
    const r = computeChargeAmounts(ChargeMode.ON_DEMAND, 5000, 1000, 0.2);
    expect(r.commissionCents).toBe(1000);
    expect(r.driverNetCents).toBe(5000); // (5000-1000)+1000
  });

  it('rechaza montos no enteros o negativos', () => {
    expect(() => computeChargeAmounts(ChargeMode.ON_DEMAND, -1, 0, 0.2)).toThrow(InvalidStateError);
    expect(() => computeChargeAmounts(ChargeMode.ON_DEMAND, 100.5, 0, 0.2)).toThrow(
      InvalidStateError,
    );
    expect(() => computeChargeAmounts(ChargeMode.ON_DEMAND, 100, -5, 0.2)).toThrow(
      InvalidStateError,
    );
  });
});

describe('computeChargeAmounts · CARPOOLING — service fee SUMADO al pasajero (F2.7 · cost-sharing)', () => {
  it('el fee se SUMA arriba: contribución 2000, fee 15% → cobrado 2300, fee 300, conductor 2000 FULL', () => {
    const r = computeChargeAmounts(ChargeMode.CARPOOLING, 2000, 0, 0.15);
    expect(r.commissionCents).toBe(300); // 15% de 2000 = serviceFee (corte de la plataforma)
    expect(r.feeCents).toBe(300); // fee visible al pasajero
    expect(r.grossCents).toBe(2300); // BRUTO cobrado = contribución + fee
    expect(r.amountCents).toBe(2300); // lo que se cobra al método de pago (sin propina/descuento)
    expect(r.driverNetCents).toBe(2000); // el conductor cobra el 100% de su contribución
  });

  it('INVARIANTE: el conductor de carpooling cobra SIEMPRE el 100% de su contribución (sin propina)', () => {
    for (const [contribution, rate] of [
      [1000, 0.1],
      [3333, 0.2],
      [4999, 0.07],
    ] as const) {
      const r = computeChargeAmounts(ChargeMode.CARPOOLING, contribution, 0, rate);
      expect(r.driverNetCents).toBe(contribution); // driverNet === contribución, NUNCA menos
      expect(r.grossCents).toBe(contribution + r.commissionCents); // bruto = contribución + fee
    }
  });

  it('la propina es 100% del conductor, sumada arriba de su contribución', () => {
    const r = computeChargeAmounts(ChargeMode.CARPOOLING, 2000, 500, 0.15);
    expect(r.driverNetCents).toBe(2500); // contribución 2000 + propina 500
    expect(r.amountCents).toBe(2800); // bruto 2300 + propina 500
  });

  it('fee 0 (sin service fee) → el pasajero paga exactamente la contribución, conductor FULL', () => {
    const r = computeChargeAmounts(ChargeMode.CARPOOLING, 3000, 0, 0);
    expect(r.commissionCents).toBe(0);
    expect(r.grossCents).toBe(3000); // contribución + 0
    expect(r.driverNetCents).toBe(3000);
  });

  it('el neto del conductor es derivable como bruto − comisión + propina (vale para ambos modos)', () => {
    const r = computeChargeAmounts(ChargeMode.CARPOOLING, 2000, 0, 0.15);
    expect(r.grossCents - r.commissionCents + r.tipCents).toBe(r.driverNetCents); // 2300 - 300 + 0 = 2000
  });
});

describe('comisión por MODO (F2.7 · ADR-017 §1.6 / ADR-015 §11.2)', () => {
  it('resolveCommissionBps(CARPOOLING, rates) devuelve carpoolingFeeBps; ON_DEMAND devuelve onDemandRateBps', () => {
    const rates = { onDemandRateBps: 2000, carpoolingFeeBps: 1500 };
    expect(resolveCommissionBps(ChargeMode.CARPOOLING, rates)).toBe(1500);
    expect(resolveCommissionBps(ChargeMode.ON_DEMAND, rates)).toBe(2000);
  });

  it('bpsToRate pliega bps Int a la fracción 0..1 que consume commission()', () => {
    expect(bpsToRate(0)).toBe(0);
    expect(bpsToRate(2000)).toBe(0.2); // 20%
    expect(bpsToRate(BPS_DENOMINATOR)).toBe(1); // 100%
  });

  it('bpsToRate rechaza bps no enteros o fuera de [0,10000] (cero float persistido)', () => {
    expect(() => bpsToRate(-1)).toThrow(InvalidStateError);
    expect(() => bpsToRate(10_001)).toThrow(InvalidStateError);
    expect(() => bpsToRate(20.5)).toThrow(InvalidStateError);
  });
});

describe('máquina de estados del pago', () => {
  it('permite PENDING → CAPTURED y PENDING → DEBT', () => {
    expect(canTransitionPayment('PENDING', 'CAPTURED')).toBe(true);
    expect(canTransitionPayment('PENDING', 'DEBT')).toBe(true);
  });

  it('permite saldar una deuda: DEBT → CAPTURED', () => {
    expect(canTransitionPayment('DEBT', 'CAPTURED')).toBe(true);
  });

  it('permite reembolsar solo lo capturado: CAPTURED → REFUNDED', () => {
    expect(canTransitionPayment('CAPTURED', 'REFUNDED')).toBe(true);
    expect(canTransitionPayment('PENDING', 'REFUNDED')).toBe(false);
  });

  it('REFUNDED es terminal', () => {
    expect(canTransitionPayment('REFUNDED', 'CAPTURED')).toBe(false);
    expect(() => assertPaymentTransition('REFUNDED', 'CAPTURED')).toThrow(InvalidStateError);
  });

  it('no permite revertir un cobro capturado a PENDING', () => {
    expect(() => assertPaymentTransition('CAPTURED', 'PENDING')).toThrow(InvalidStateError);
  });

  it('permite la transición trivial a sí mismo (idempotencia de estado)', () => {
    expect(canTransitionPayment('CAPTURED', 'CAPTURED')).toBe(true);
  });
});

describe('propina sobre un cobro (BR-P04)', () => {
  it('admite propina sobre PENDING y CAPTURED', () => {
    expect(canAddTip('PENDING')).toBe(true);
    expect(canAddTip('CAPTURED')).toBe(true);
  });

  it('rechaza propina sobre REFUNDED, FAILED o DEBT', () => {
    expect(canAddTip('REFUNDED')).toBe(false);
    expect(canAddTip('FAILED')).toBe(false);
    expect(canAddTip('DEBT')).toBe(false);
    expect(() => assertCanAddTip('REFUNDED')).toThrow(InvalidStateError);
  });
});

describe('backoff de reintentos (BR-P02)', () => {
  it('crece exponencialmente: base, 2x, 4x', () => {
    expect(retryDelayMs(1, 500)).toBe(500);
    expect(retryDelayMs(2, 500)).toBe(1000);
    expect(retryDelayMs(3, 500)).toBe(2000);
  });
});

describe('idempotencia · dedupKey determinista por viaje', () => {
  it('mismo tripId → misma dedupKey', () => {
    const trip = '0190b8a0-0000-7000-8000-000000000001';
    expect(deriveTripChargeDedupKey(trip)).toBe(deriveTripChargeDedupKey(trip));
    expect(deriveTripChargeDedupKey(trip)).toBe(`trip-completed:${trip}`);
  });
});
