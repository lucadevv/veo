import { describe, it, expect } from 'vitest';
import { AdminRole, ADMIN_ROLE_RANK, maxRoleRank, canGrantRoles } from '../src/enums/index.js';

describe('ADMIN_ROLE_RANK · exhaustividad y orden', () => {
  it('cubre TODOS los roles del enum (Record exhaustivo)', () => {
    const enumRoles = Object.values(AdminRole).sort();
    const rankRoles = Object.keys(ADMIN_ROLE_RANK).sort();
    expect(rankRoles).toEqual(enumRoles);
  });

  it('SUPERADMIN es el rango más alto', () => {
    const max = Math.max(...Object.values(ADMIN_ROLE_RANK));
    expect(ADMIN_ROLE_RANK[AdminRole.SUPERADMIN]).toBe(max);
  });

  it('ADMIN < SUPERADMIN y SUPPORT_L1 < ADMIN', () => {
    expect(ADMIN_ROLE_RANK[AdminRole.ADMIN]).toBeLessThan(ADMIN_ROLE_RANK[AdminRole.SUPERADMIN]);
    expect(ADMIN_ROLE_RANK[AdminRole.SUPPORT_L1]).toBeLessThan(ADMIN_ROLE_RANK[AdminRole.ADMIN]);
  });
});

describe('maxRoleRank', () => {
  it('devuelve el rango del rol más alto', () => {
    expect(maxRoleRank([AdminRole.SUPPORT_L1, AdminRole.ADMIN])).toBe(
      ADMIN_ROLE_RANK[AdminRole.ADMIN],
    );
  });

  it('sin roles → 0', () => {
    expect(maxRoleRank([])).toBe(0);
  });
});

describe('canGrantRoles · estricta (<) con excepción SUPERADMIN→SUPERADMIN', () => {
  it('ADMIN NO puede otorgar [SUPERADMIN] (escalada bloqueada)', () => {
    expect(canGrantRoles([AdminRole.ADMIN], [AdminRole.SUPERADMIN])).toBe(false);
  });

  it('ADMIN NO puede otorgar [ADMIN] (regla estricta: igual rango no permitido)', () => {
    expect(canGrantRoles([AdminRole.ADMIN], [AdminRole.ADMIN])).toBe(false);
  });

  it('ADMIN puede otorgar [SUPPORT_L2, FINANCE] (rangos menores)', () => {
    expect(canGrantRoles([AdminRole.ADMIN], [AdminRole.SUPPORT_L2, AdminRole.FINANCE])).toBe(true);
  });

  it('SUPERADMIN puede otorgar [SUPERADMIN] (excepción explícita)', () => {
    expect(canGrantRoles([AdminRole.SUPERADMIN], [AdminRole.SUPERADMIN])).toBe(true);
  });

  it('SUPERADMIN puede otorgar [ADMIN]', () => {
    expect(canGrantRoles([AdminRole.SUPERADMIN], [AdminRole.ADMIN])).toBe(true);
  });

  it('un solo target inválido invalida todo el lote', () => {
    expect(canGrantRoles([AdminRole.ADMIN], [AdminRole.SUPPORT_L2, AdminRole.SUPERADMIN])).toBe(
      false,
    );
  });

  it('actor sin roles no puede otorgar nada', () => {
    expect(canGrantRoles([], [AdminRole.SUPPORT_L1])).toBe(false);
  });
});
