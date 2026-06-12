import { describe, it, expect } from 'vitest';
import { BackgroundCheckStatus } from '../generated/prisma';
import { InvalidStatusTransition } from './state-machine';
import { backgroundCheckMachine, isBackgroundCleared } from './background-check';

const ALL_STATES = Object.values(BackgroundCheckStatus);

/** Transiciones válidas esperadas, independientes de la tabla de producción (no tautologizar). */
const EXPECTED_VALID = new Set<string>([
  // decisión del operador
  `${BackgroundCheckStatus.PENDING}->${BackgroundCheckStatus.CLEARED}`,
  `${BackgroundCheckStatus.PENDING}->${BackgroundCheckStatus.REJECTED}`,
  // revocación por hallazgo posterior
  `${BackgroundCheckStatus.CLEARED}->${BackgroundCheckStatus.REJECTED}`,
  // re-evaluación / apelación aprobada
  `${BackgroundCheckStatus.REJECTED}->${BackgroundCheckStatus.CLEARED}`,
  // resubmit: el conductor rechazado corrige y reenvía a revisión (vuelve a la cola de aprobación)
  `${BackgroundCheckStatus.REJECTED}->${BackgroundCheckStatus.PENDING}`,
]);

describe('Eje Driver.backgroundCheckStatus · cobertura del producto cartesiano (BR-I01)', () => {
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const shouldBeValid = from === to || EXPECTED_VALID.has(`${from}->${to}`);

      it(`${from} → ${to} ${shouldBeValid ? 'es válida' : 'es inválida'}`, () => {
        expect(backgroundCheckMachine.canTransition(from, to)).toBe(shouldBeValid);
        if (shouldBeValid) {
          expect(() => backgroundCheckMachine.assertTransition(from, to)).not.toThrow();
        } else {
          expect(() => backgroundCheckMachine.assertTransition(from, to)).toThrow(
            InvalidStatusTransition,
          );
        }
      });
    }
  }

  it('una APROBACIÓN no vuelve sola a PENDING (CLEARED no se "des-decide")', () => {
    expect(
      backgroundCheckMachine.canTransition(
        BackgroundCheckStatus.CLEARED,
        BackgroundCheckStatus.PENDING,
      ),
    ).toBe(false);
  });

  it('un RECHAZO sí puede volver a PENDING (resubmit del conductor: corrige y reenvía)', () => {
    expect(
      backgroundCheckMachine.canTransition(
        BackgroundCheckStatus.REJECTED,
        BackgroundCheckStatus.PENDING,
      ),
    ).toBe(true);
  });

  it('un status legacy fuera del enum es inválido hacia todo destino (fail-closed)', () => {
    const legacy = 'LEGACY_GARBAGE' as BackgroundCheckStatus;
    for (const to of ALL_STATES) {
      expect(() => backgroundCheckMachine.assertTransition(legacy, to)).toThrow(
        InvalidStatusTransition,
      );
    }
  });
});

describe('isBackgroundCleared · el predicado del gate de turno', () => {
  it('solo CLEARED cuenta como aprobado', () => {
    expect(isBackgroundCleared(BackgroundCheckStatus.CLEARED)).toBe(true);
    expect(isBackgroundCleared(BackgroundCheckStatus.PENDING)).toBe(false);
    expect(isBackgroundCleared(BackgroundCheckStatus.REJECTED)).toBe(false);
  });

  it('un status legacy fuera del enum NO cuenta como aprobado (fail-closed)', () => {
    expect(isBackgroundCleared('LEGACY_GARBAGE' as BackgroundCheckStatus)).toBe(false);
  });
});
