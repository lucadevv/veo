import { describe, it, expect } from 'vitest';
import { AdminRole } from '@veo/shared-types';
import {
  canSeeIdentity,
  canSeeAmounts,
  canSeePlate,
  canSeeExactTripGeo,
  maskPlate,
  coarseGeo,
} from './redaction.policy';

const ALL_ROLES: AdminRole[] = [
  AdminRole.SUPPORT_L1,
  AdminRole.SUPPORT_L2,
  AdminRole.DISPATCHER,
  AdminRole.FINANCE,
  AdminRole.COMPLIANCE_SUPERVISOR,
  AdminRole.ADMIN,
  AdminRole.SUPERADMIN,
];

/** Tabla: para cada predicado, el conjunto EXACTO de roles que devuelve `true` (matriz aprobada). */
const CASES: Array<{ name: string; fn: (r: AdminRole[]) => boolean; allowed: AdminRole[] }> = [
  {
    name: 'canSeeIdentity',
    fn: canSeeIdentity,
    allowed: [AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN],
  },
  {
    name: 'canSeeAmounts',
    fn: canSeeAmounts,
    allowed: [AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN],
  },
  {
    name: 'canSeePlate',
    fn: canSeePlate,
    allowed: [
      AdminRole.DISPATCHER,
      AdminRole.COMPLIANCE_SUPERVISOR,
      AdminRole.ADMIN,
      AdminRole.SUPERADMIN,
    ],
  },
  {
    name: 'canSeeExactTripGeo',
    fn: canSeeExactTripGeo,
    allowed: [
      AdminRole.DISPATCHER,
      AdminRole.COMPLIANCE_SUPERVISOR,
      AdminRole.ADMIN,
      AdminRole.SUPERADMIN,
    ],
  },
];

describe('redaction.policy · predicados por rol (matriz aprobada)', () => {
  for (const { name, fn, allowed } of CASES) {
    describe(name, () => {
      for (const role of ALL_ROLES) {
        const expected = allowed.includes(role);
        it(`${role} → ${expected}`, () => {
          expect(fn([role])).toBe(expected);
        });
      }
      it('sin roles → false (deny por defecto)', () => {
        expect(fn([])).toBe(false);
      });
      it('múltiples roles: alcanza con uno permitido', () => {
        expect(fn([AdminRole.SUPPORT_L1, ...allowed.slice(0, 1)])).toBe(true);
      });
    });
  }
});

describe('redaction.policy · maskPlate', () => {
  it("placa normal → '•••' + últimos 3", () => {
    expect(maskPlate('ABC-123')).toBe('•••123');
  });
  it('placa corta (≤3) → prefijo + lo que haya, sin inventar', () => {
    expect(maskPlate('XY')).toBe('•••XY');
  });
  it('null → null (no hay dato, no se inventa)', () => {
    expect(maskPlate(null)).toBeNull();
  });
});

describe('redaction.policy · coarseGeo', () => {
  it('redondea lat/lon a 3 decimales (~100m)', () => {
    expect(coarseGeo({ lat: -12.054321, lon: -77.041234 })).toEqual({ lat: -12.054, lon: -77.041 });
  });
  it('no altera coords ya de 3 decimales', () => {
    expect(coarseGeo({ lat: -12.05, lon: -77.04 })).toEqual({ lat: -12.05, lon: -77.04 });
  });
  it('null → null', () => {
    expect(coarseGeo(null)).toBeNull();
  });
});
