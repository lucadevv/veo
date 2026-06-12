import { describe, it, expect } from 'vitest';
import { KycStatus } from '../generated/prisma';
import { InvalidStatusTransition } from './state-machine';
import { kycStatusMachine } from './kyc-status';

const ALL_STATES = Object.values(KycStatus);

/** Transiciones válidas esperadas, independientes de la tabla de producción (no tautologizar). */
const EXPECTED_VALID = new Set<string>([
  // resultado de la verificación (biométrica u operador)
  `${KycStatus.PENDING}->${KycStatus.VERIFIED}`,
  `${KycStatus.PENDING}->${KycStatus.REJECTED}`,
  // la verificación caduca o se revoca
  `${KycStatus.VERIFIED}->${KycStatus.EXPIRED}`,
  `${KycStatus.VERIFIED}->${KycStatus.REJECTED}`,
  // re-verificación exitosa (el rechazo no es terminal)
  `${KycStatus.REJECTED}->${KycStatus.VERIFIED}`,
  // re-verificación tras caducar
  `${KycStatus.EXPIRED}->${KycStatus.VERIFIED}`,
  `${KycStatus.EXPIRED}->${KycStatus.REJECTED}`,
]);

describe('Eje User.kycStatus · cobertura del producto cartesiano', () => {
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const shouldBeValid = from === to || EXPECTED_VALID.has(`${from}->${to}`);

      it(`${from} → ${to} ${shouldBeValid ? 'es válida' : 'es inválida'}`, () => {
        expect(kycStatusMachine.canTransition(from, to)).toBe(shouldBeValid);
        if (shouldBeValid) {
          expect(() => kycStatusMachine.assertTransition(from, to)).not.toThrow();
        } else {
          expect(() => kycStatusMachine.assertTransition(from, to)).toThrow(
            InvalidStatusTransition,
          );
        }
      });
    }
  }

  it('una verificación decidida nunca vuelve a PENDING (no se "des-decide")', () => {
    for (const from of [KycStatus.VERIFIED, KycStatus.REJECTED, KycStatus.EXPIRED]) {
      expect(kycStatusMachine.canTransition(from, KycStatus.PENDING)).toBe(false);
    }
  });

  it('solo VERIFIED caduca: REJECTED → EXPIRED y PENDING → EXPIRED son inválidas', () => {
    expect(kycStatusMachine.canTransition(KycStatus.REJECTED, KycStatus.EXPIRED)).toBe(false);
    expect(kycStatusMachine.canTransition(KycStatus.PENDING, KycStatus.EXPIRED)).toBe(false);
  });

  it('re-verificar a un pasajero ya VERIFIED es idempotente (VERIFIED → VERIFIED)', () => {
    expect(() =>
      kycStatusMachine.assertTransition(KycStatus.VERIFIED, KycStatus.VERIFIED),
    ).not.toThrow();
  });

  it('un kycStatus legacy fuera del enum es inválido hacia todo destino (fail-closed)', () => {
    const legacy = 'LEGACY_GARBAGE' as KycStatus;
    for (const to of ALL_STATES) {
      expect(() => kycStatusMachine.assertTransition(legacy, to)).toThrow(
        InvalidStatusTransition,
      );
    }
  });
});
