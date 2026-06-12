import { describe, it, expect } from 'vitest';
import { AdminStatus } from '../generated/prisma';
import { InvalidStatusTransition } from './state-machine';
import { adminStatusMachine, isOperationalAdmin } from './admin-status';

const ALL_STATES = Object.values(AdminStatus);

/** Transiciones válidas esperadas, independientes de la tabla de producción (no tautologizar). */
const EXPECTED_VALID = new Set<string>([
  // decisión sobre el auto-registro
  `${AdminStatus.PENDING}->${AdminStatus.ACTIVE}`,
  `${AdminStatus.PENDING}->${AdminStatus.REJECTED}`,
  // suspensión / revocación de un operador activo
  `${AdminStatus.ACTIVE}->${AdminStatus.SUSPENDED}`,
  `${AdminStatus.ACTIVE}->${AdminStatus.REJECTED}`,
  // rehabilitación / revocación definitiva
  `${AdminStatus.SUSPENDED}->${AdminStatus.ACTIVE}`,
  `${AdminStatus.SUSPENDED}->${AdminStatus.REJECTED}`,
  // re-evaluación aprobada de un rechazo
  `${AdminStatus.REJECTED}->${AdminStatus.ACTIVE}`,
]);

describe('Eje AdminUser.status · cobertura del producto cartesiano', () => {
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const shouldBeValid = from === to || EXPECTED_VALID.has(`${from}->${to}`);

      it(`${from} → ${to} ${shouldBeValid ? 'es válida' : 'es inválida'}`, () => {
        expect(adminStatusMachine.canTransition(from, to)).toBe(shouldBeValid);
        if (shouldBeValid) {
          expect(() => adminStatusMachine.assertTransition(from, to)).not.toThrow();
        } else {
          expect(() => adminStatusMachine.assertTransition(from, to)).toThrow(
            InvalidStatusTransition,
          );
        }
      });
    }
  }

  it('una solicitud decidida no vuelve a PENDING', () => {
    for (const from of [AdminStatus.ACTIVE, AdminStatus.SUSPENDED, AdminStatus.REJECTED]) {
      expect(adminStatusMachine.canTransition(from, AdminStatus.PENDING)).toBe(false);
    }
  });

  it('re-aprobar un ACTIVE para cambiarle roles es idempotente (ACTIVE → ACTIVE)', () => {
    expect(() =>
      adminStatusMachine.assertTransition(AdminStatus.ACTIVE, AdminStatus.ACTIVE),
    ).not.toThrow();
  });

  it('un status legacy fuera del enum es inválido hacia todo destino (fail-closed)', () => {
    const legacy = 'LEGACY_GARBAGE' as AdminStatus;
    for (const to of ALL_STATES) {
      expect(() => adminStatusMachine.assertTransition(legacy, to)).toThrow(
        InvalidStatusTransition,
      );
    }
  });
});

describe('isOperationalAdmin · el predicado de login/step-up', () => {
  it('solo ACTIVE puede operar el panel', () => {
    expect(isOperationalAdmin({ status: AdminStatus.ACTIVE })).toBe(true);
    expect(isOperationalAdmin({ status: AdminStatus.PENDING })).toBe(false);
    expect(isOperationalAdmin({ status: AdminStatus.SUSPENDED })).toBe(false);
    expect(isOperationalAdmin({ status: AdminStatus.REJECTED })).toBe(false);
  });

  it('un status legacy fuera del enum NO puede operar (fail-closed)', () => {
    expect(isOperationalAdmin({ status: 'LEGACY_GARBAGE' as AdminStatus })).toBe(false);
  });
});
