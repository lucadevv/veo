/**
 * Helper compartido del trust boundary del lado conductor (#9): deriva el driverId de la identidad
 * FIRMADA o falla CERRADO (403) si la identidad no es de un conductor. Fuente única para puja + ofertas.
 */
import { describe, it, expect } from 'vitest';
import type { AuthenticatedUser } from '@veo/auth';
import { requireDriverId } from './require-driver-id';

describe('requireDriverId — fail-closed del trust boundary conductor (#9)', () => {
  it('devuelve el driverId de la identidad FIRMADA', () => {
    const user: AuthenticatedUser = {
      userId: 'u1',
      type: 'driver',
      roles: [],
      sessionId: 's1',
      driverId: 'drv-9',
    };
    expect(requireDriverId(user)).toBe('drv-9');
  });

  it('identidad SIN driverId (passenger/admin) → 403 (fail-closed)', () => {
    const passenger: AuthenticatedUser = { userId: 'u2', type: 'passenger', roles: [], sessionId: 's2' };
    expect(() => requireDriverId(passenger)).toThrowError(
      expect.objectContaining({ httpStatus: 403 }),
    );
  });

  it('identidad undefined → 403 (fail-closed)', () => {
    expect(() => requireDriverId(undefined)).toThrowError(
      expect.objectContaining({ httpStatus: 403 }),
    );
  });
});
