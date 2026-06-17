import { describe, it, expect } from 'vitest';
import { DriverStatus } from '../generated/prisma';
import { InvalidStatusTransition } from './state-machine';
import { driverStatusMachine } from './driver-status';

const ALL_STATES = Object.values(DriverStatus);

/**
 * Transiciones válidas esperadas, declaradas independientes de la tabla de producción para no
 * tautologizar el test (espejo de trip-state-machine.spec). from === to (idempotente) se cubre
 * aparte en el bucle. Si la tabla cambia, este set debe cambiar.
 */
const EXPECTED_VALID = new Set<string>([
  // inicio de turno (solo vía gate biométrico de startShift)
  `${DriverStatus.OFFLINE}->${DriverStatus.AVAILABLE}`,
  // ciclo en turno
  `${DriverStatus.AVAILABLE}->${DriverStatus.ASSIGNED}`,
  `${DriverStatus.AVAILABLE}->${DriverStatus.ON_BREAK}`,
  `${DriverStatus.ASSIGNED}->${DriverStatus.ON_TRIP}`,
  `${DriverStatus.ASSIGNED}->${DriverStatus.AVAILABLE}`,
  `${DriverStatus.ON_TRIP}->${DriverStatus.AVAILABLE}`,
  `${DriverStatus.ON_BREAK}->${DriverStatus.AVAILABLE}`,
  // fin de turno desde cualquier estado EN TURNO
  `${DriverStatus.AVAILABLE}->${DriverStatus.OFFLINE}`,
  `${DriverStatus.ASSIGNED}->${DriverStatus.OFFLINE}`,
  `${DriverStatus.ON_TRIP}->${DriverStatus.OFFLINE}`,
  `${DriverStatus.ON_BREAK}->${DriverStatus.OFFLINE}`,
  // suspensión en cualquier momento del turno
  `${DriverStatus.AVAILABLE}->${DriverStatus.SUSPENDED}`,
  `${DriverStatus.ASSIGNED}->${DriverStatus.SUSPENDED}`,
  `${DriverStatus.ON_TRIP}->${DriverStatus.SUSPENDED}`,
  `${DriverStatus.ON_BREAK}->${DriverStatus.SUSPENDED}`,
  // SUSPENDED solo sale hacia OFFLINE (el regreso exige re-pasar el gate biométrico)
  `${DriverStatus.SUSPENDED}->${DriverStatus.OFFLINE}`,
]);

describe('Eje Driver.currentStatus · cobertura del producto cartesiano', () => {
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const shouldBeValid = from === to || EXPECTED_VALID.has(`${from}->${to}`);

      it(`${from} → ${to} ${shouldBeValid ? 'es válida' : 'es inválida'}`, () => {
        expect(driverStatusMachine.canTransition(from, to)).toBe(shouldBeValid);
        if (shouldBeValid) {
          expect(() => driverStatusMachine.assertTransition(from, to)).not.toThrow();
        } else {
          expect(() => driverStatusMachine.assertTransition(from, to)).toThrow(
            InvalidStatusTransition,
          );
        }
      });
    }
  }

  it('no hay pausa sin turno: OFFLINE → ON_BREAK es inválida', () => {
    expect(driverStatusMachine.canTransition(DriverStatus.OFFLINE, DriverStatus.ON_BREAK)).toBe(
      false,
    );
  });

  it('SUSPENDED no puede auto-ponerse AVAILABLE (solo sale hacia OFFLINE)', () => {
    expect(driverStatusMachine.canTransition(DriverStatus.SUSPENDED, DriverStatus.AVAILABLE)).toBe(
      false,
    );
    expect(driverStatusMachine.canTransition(DriverStatus.SUSPENDED, DriverStatus.OFFLINE)).toBe(
      true,
    );
  });

  it('un currentStatus legacy fuera del enum es inválido hacia TODO destino (fail-closed)', () => {
    const legacy = 'LEGACY_GARBAGE' as DriverStatus;
    for (const to of ALL_STATES) {
      expect(driverStatusMachine.canTransition(legacy, to)).toBe(false);
      expect(() => driverStatusMachine.assertTransition(legacy, to)).toThrow(
        InvalidStatusTransition,
      );
    }
  });
});
