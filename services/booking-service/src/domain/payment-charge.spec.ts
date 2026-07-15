/**
 * Spec del dominio del borde de pago (ADR-014 §5.3/§5.4): la dedupKey financiera DETERMINISTA y el error
 * tipado del gate de deuda.
 */
import { describe, it, expect } from 'vitest';
import { UnprocessableEntityError } from '@veo/utils';
import { deriveBookingChargeDedupKey, PassengerHasDebtError } from './payment-charge';

describe('deriveBookingChargeDedupKey (§5.3 · idempotencia financiera)', () => {
  it('deriva booking-charge:{bookingId} de forma determinista', () => {
    const id = '00000000-0000-0000-0000-0000000000a1';
    expect(deriveBookingChargeDedupKey(id)).toBe(`booking-charge:${id}`);
  });

  it('mismo bookingId → MISMA key (un reintento del cobro no duplica el Payment)', () => {
    const id = '00000000-0000-0000-0000-0000000000a1';
    expect(deriveBookingChargeDedupKey(id)).toBe(deriveBookingChargeDedupKey(id));
  });

  it('bookingIds distintos → keys distintas', () => {
    expect(deriveBookingChargeDedupKey('a')).not.toBe(deriveBookingChargeDedupKey('b'));
  });
});

describe('PassengerHasDebtError (§5.4 · gate de deuda)', () => {
  it('es un UnprocessableEntityError (422) y lleva el monto bloqueante en details', () => {
    const err = new PassengerHasDebtError(1500);
    expect(err).toBeInstanceOf(UnprocessableEntityError);
    expect(err.httpStatus).toBe(422);
    expect(err.details).toMatchObject({ totalCents: 1500 });
  });
});
