import { describe, it, expect } from 'vitest';
import { getPolicyDef, POLICY_KEYS, type PolicyKey } from '@veo/policy';
import { derivePolicyRule, derivePolicyScopeRows, derivePolicyFootprint, policyRoles } from './gobierno';

/**
 * Derivación de la Regla (WHEN/THEN técnica), el Alcance (Acciones/Recursos/Roles) y el Impacto (footprint) del
 * detalle de una política (board `jznes`). Son PRESENTACIÓN de la semántica real (catálogo §5 + PERMISSION_ROLES) y
 * los `params` — no backend. Acá se fija que la traducción es fiel a la config y NO inventa lo que la política no tiene.
 */
describe('derivePolicyRule — traduce key + params a WHEN/THEN técnico', () => {
  it('cubre las 16 políticas del catálogo (sin key sin regla)', () => {
    for (const key of POLICY_KEYS) {
      const def = getPolicyDef(key);
      const rule = derivePolicyRule(def, def.defaults);
      expect(rule.when.length).toBeGreaterThan(0);
      expect(rule.then.length).toBeGreaterThan(0);
    }
  });

  it('media.dual-auth: interpola approvers en el efecto', () => {
    const def = getPolicyDef('media.dual-auth');
    const rule = derivePolicyRule(def, { approvers: 3 });
    expect(rule.then.some((c) => c.term === 'approvers' && c.value.includes('3'))).toBe(true);
  });

  it('media.dual-auth: NO inventa un ttl (dual-auth no lo tiene en el contrato)', () => {
    const def = getPolicyDef('media.dual-auth');
    const rule = derivePolicyRule(def, def.defaults);
    expect([...rule.when, ...rule.then].some((c) => c.term === 'ttl')).toBe(false);
  });

  it('auth.session-timeout: interpola idleMin en la condición', () => {
    const def = getPolicyDef('auth.session-timeout');
    const rule = derivePolicyRule(def, { idleMin: 45 });
    expect(rule.when.some((c) => c.value.includes('45 min'))).toBe(true);
  });

  it('access.ip-allowlist: lista vacía → allow_all (no bloquea a nadie)', () => {
    const def = getPolicyDef('access.ip-allowlist');
    const rule = derivePolicyRule(def, { cidrs: [] });
    expect(rule.then.some((c) => c.value.includes('allow_all'))).toBe(true);
  });

  it('access.ip-allowlist: con rangos → deny', () => {
    const def = getPolicyDef('access.ip-allowlist');
    const rule = derivePolicyRule(def, { cidrs: ['10.0.0.0/8', '190.0.0.0/16'] });
    expect(rule.when.some((c) => c.value.includes('2 cidr'))).toBe(true);
    expect(rule.then.some((c) => c.value === 'deny')).toBe(true);
  });
});

describe('derivePolicyScopeRows — 3 filas del Alcance (Acciones/Recursos/Roles)', () => {
  it('siempre 3 filas, con Acciones y Recursos no vacíos', () => {
    for (const key of POLICY_KEYS) {
      const def = getPolicyDef(key);
      const [acciones, recursos, roles] = derivePolicyScopeRows(def, def.defaults);
      expect(acciones?.label).toBe('Acciones');
      expect(acciones?.chips.length).toBeGreaterThan(0);
      expect(recursos?.label).toBe('Recursos');
      expect(recursos?.chips.length).toBeGreaterThan(0);
      expect(roles).toBeDefined();
    }
  });

  it('media.dual-auth: roles alcanzados = quienes acceden a video (CMP/ADM/SUP), derivado de PERMISSION_ROLES', () => {
    const def = getPolicyDef('media.dual-auth');
    const roleRow = derivePolicyScopeRows(def, def.defaults)[2];
    expect(roleRow?.label).toBe('Roles alcanzados');
    expect(roleRow?.chips).toHaveLength(3);
  });

  it('pii.mask: la 3ra fila refleja revealRoles TAL CUAL (config real, sin filtrar)', () => {
    const def = getPolicyDef('pii.mask');
    const params = { dniTail: 4, revealRoles: ['COMPLIANCE', 'SUPERADMIN'] };
    const roleRow = derivePolicyScopeRows(def, params)[2];
    expect(policyRoles(def, params)).toEqual(['COMPLIANCE', 'SUPERADMIN']);
    expect(roleRow?.chips).toHaveLength(2);
  });

  it('ops.export vacío → fila de roles vacía con hint honesto (no habilita a nadie)', () => {
    const def = getPolicyDef('ops.export');
    const roleRow = derivePolicyScopeRows(def, { allowedRoles: [] })[2];
    expect(roleRow?.chips).toHaveLength(0);
    expect(roleRow?.emptyHint).toBeTruthy();
  });

  it('access.ip-allowlist: la 3ra fila son los rangos CIDR (su scope real)', () => {
    const def = getPolicyDef('access.ip-allowlist');
    const roleRow = derivePolicyScopeRows(def, { cidrs: ['10.0.0.0/8'] })[2];
    expect(roleRow?.label).toBe('Rangos IP');
    expect(roleRow?.chips).toEqual(['10.0.0.0/8']);
  });
});

describe('derivePolicyFootprint — blast-radius real (roles/recursos/apps)', () => {
  it('cuenta roles/recursos/apps reales; una política global alcanza los 7 roles', () => {
    const def = getPolicyDef('auth.mfa');
    const fp = derivePolicyFootprint(def, def.defaults);
    expect(fp.roles).toBe(7);
    expect(fp.recursos).toBeGreaterThan(0);
    expect(fp.apps).toBeGreaterThan(0);
  });

  it('media.dual-auth: 3 roles alcanzados (no los 7 — solo quienes acceden a video)', () => {
    const def = getPolicyDef('media.dual-auth');
    const fp = derivePolicyFootprint(def, def.defaults);
    expect(fp.roles).toBe(3);
  });
});
