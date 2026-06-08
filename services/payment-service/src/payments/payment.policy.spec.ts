import { describe, it, expect } from 'vitest';
import { InvalidStateError } from '@veo/utils';
import {
  assertCanAddTip,
  assertPaymentTransition,
  canAddTip,
  canTransitionPayment,
  computeChargeAmounts,
  deriveTripChargeDedupKey,
  retryDelayMs,
} from './payment.policy';

describe('computeChargeAmounts · comisión (BR-P04)', () => {
  it('aplica el 20% sobre el bruto y excluye la propina', () => {
    // Bruto S/20.00 = 2000 céntimos, propina S/3.00 = 300, rate 0.2.
    const r = computeChargeAmounts(2000, 300, 0.2);
    expect(r.commissionCents).toBe(400); // 20% de 2000
    expect(r.feeCents).toBe(400); // fee visible = comisión
    expect(r.amountCents).toBe(2300); // bruto + propina cobrados al pasajero
    expect(r.driverNetCents).toBe(1900); // (2000 - 400) + 300
  });

  it('redondea la comisión a céntimos enteros', () => {
    // 20% de 1505 = 301 (301.0). Probamos un caso con redondeo: 20% de 1503 = 300.6 → 301.
    const r = computeChargeAmounts(1503, 0, 0.2);
    expect(r.commissionCents).toBe(301);
    expect(r.amountCents).toBe(1503);
    expect(r.driverNetCents).toBe(1202);
  });

  it('una tarifa con surge (mayor bruto) paga más comisión, propina intacta', () => {
    const r = computeChargeAmounts(5000, 1000, 0.2);
    expect(r.commissionCents).toBe(1000);
    expect(r.driverNetCents).toBe(5000); // (5000-1000)+1000
  });

  it('rechaza montos no enteros o negativos', () => {
    expect(() => computeChargeAmounts(-1, 0, 0.2)).toThrow(InvalidStateError);
    expect(() => computeChargeAmounts(100.5, 0, 0.2)).toThrow(InvalidStateError);
    expect(() => computeChargeAmounts(100, -5, 0.2)).toThrow(InvalidStateError);
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
