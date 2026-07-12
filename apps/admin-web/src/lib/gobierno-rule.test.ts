import { describe, it, expect } from 'vitest';
import { getPolicyDef, POLICY_KEYS, type PolicyKey } from '@veo/policy';
import { derivePolicyRule, derivePolicyScope } from './gobierno';

/**
 * Derivación de la Regla (WHEN/THEN) y el Alcance del detalle de una política (board `jznes`). Son PRESENTACIÓN
 * de la config existente (key + params), no backend: acá se fija que la traducción es fiel a los `params` y que
 * NO inventa un alcance que la política no declare.
 */
describe('derivePolicyRule — traduce key + params a WHEN/THEN legible', () => {
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
    expect(rule.then.some((c) => c.value.includes('3 personas'))).toBe(true);
  });

  it('auth.session-timeout: interpola idleMin en la condición', () => {
    const def = getPolicyDef('auth.session-timeout');
    const rule = derivePolicyRule(def, { idleMin: 45 });
    expect(rule.when.some((c) => c.value.includes('45 min'))).toBe(true);
  });

  it('access.ip-allowlist: lista vacía → "sin restricción" (no bloquea a nadie)', () => {
    const def = getPolicyDef('access.ip-allowlist');
    const rule = derivePolicyRule(def, { cidrs: [] });
    expect(rule.then.some((c) => c.value.includes('sin restricción'))).toBe(true);
  });

  it('access.ip-allowlist: con rangos → deniega el acceso admin', () => {
    const def = getPolicyDef('access.ip-allowlist');
    const rule = derivePolicyRule(def, { cidrs: ['10.0.0.0/8', '190.0.0.0/16'] });
    expect(rule.when.some((c) => c.value.includes('2 rango'))).toBe(true);
    expect(rule.then.some((c) => c.value.includes('denegar'))).toBe(true);
  });
});

describe('derivePolicyScope — alcance derivado de params, o global', () => {
  it('pii.mask → roles (revealRoles)', () => {
    const def = getPolicyDef('pii.mask');
    const scope = derivePolicyScope(def, { dniTail: 4, revealRoles: ['COMPLIANCE', 'SUPERADMIN'] });
    expect(scope).toEqual({ kind: 'roles', roles: ['COMPLIANCE', 'SUPERADMIN'] });
  });

  it('ops.export / ops.bulk-download → roles (allowedRoles)', () => {
    for (const key of ['ops.export', 'ops.bulk-download'] as PolicyKey[]) {
      const scope = derivePolicyScope(getPolicyDef(key), { allowedRoles: ['FINANCE'] });
      expect(scope).toEqual({ kind: 'roles', roles: ['FINANCE'] });
    }
  });

  it('access.ip-allowlist → cidrs', () => {
    const def = getPolicyDef('access.ip-allowlist');
    const scope = derivePolicyScope(def, { cidrs: ['10.0.0.0/8'] });
    expect(scope).toEqual({ kind: 'cidrs', cidrs: ['10.0.0.0/8'] });
  });

  it('el resto → global (no inventa un alcance que la política no declara)', () => {
    for (const key of ['auth.mfa', 'auth.stepup', 'media.dual-auth', 'privacy.erasure'] as PolicyKey[]) {
      expect(derivePolicyScope(getPolicyDef(key), getPolicyDef(key).defaults)).toEqual({
        kind: 'global',
      });
    }
  });
});
