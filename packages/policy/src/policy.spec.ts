import { describe, it, expect } from 'vitest';
import { POLICY_KEYS, POLICY_CATALOG, POLICY_LIST } from './index.js';
import { getPolicyDef, DEFAULT_PARAMS, validateParams, safeValidateParams } from './index.js';
import { DefaultPolicyReader } from './index.js';
import type { PolicyKey } from './index.js';

describe('POLICY_CATALOG — integridad', () => {
  it('tiene exactamente las 16 keys, sin duplicados', () => {
    expect(POLICY_KEYS).toHaveLength(16);
    expect(new Set(POLICY_KEYS).size).toBe(16);
  });

  it('la key de cada entrada coincide con su índice en el catálogo', () => {
    for (const key of POLICY_KEYS) {
      expect(POLICY_CATALOG[key].key).toBe(key);
    }
  });

  it('POLICY_LIST está en el orden canónico del ADR', () => {
    expect(POLICY_LIST.map((d) => d.key)).toEqual([...POLICY_KEYS]);
  });

  it('toda familia es una de las 4 válidas', () => {
    const families = new Set(['auth', 'data', 'access', 'ops']);
    for (const key of POLICY_KEYS) {
      expect(families.has(POLICY_CATALOG[key].family)).toBe(true);
    }
  });

  it('las mandatory arrancan enabled (no se pueden apagar)', () => {
    for (const key of POLICY_KEYS) {
      const def = POLICY_CATALOG[key];
      if (def.mandatory) {
        expect(def.defaultEnabled).toBe(true);
      }
    }
  });
});

describe('paramsSchema — los defaults validan', () => {
  it('cada default del catálogo pasa su propio schema Zod', () => {
    for (const key of POLICY_KEYS) {
      const def = POLICY_CATALOG[key];
      const result = def.paramsSchema.safeParse(def.defaults);
      expect(result.success, `defaults inválidos para ${key}`).toBe(true);
    }
  });
});

describe('validateParams — rechaza inválidos', () => {
  it('acepta params válidos y los devuelve parseados', () => {
    expect(validateParams('auth.stepup', { maxAgeSec: 120 })).toEqual({ maxAgeSec: 120 });
  });

  it('rechaza un param de tipo incorrecto', () => {
    expect(() => validateParams('auth.stepup', { maxAgeSec: 'nope' })).toThrow();
  });

  it('rechaza un valor fuera de rango (approvers < 2)', () => {
    expect(() => validateParams('media.dual-auth', { approvers: 1 })).toThrow();
  });

  it('rechaza claves extra (schema strict)', () => {
    expect(() => validateParams('auth.mfa', { foo: 1 })).toThrow();
  });

  it('safeValidateParams no lanza y devuelve el envelope de Zod', () => {
    const ok = safeValidateParams('media.retention', { days: 45 });
    expect(ok.success).toBe(true);
    const bad = safeValidateParams('media.retention', { days: 0 });
    expect(bad.success).toBe(false);
  });

  it('getPolicyDef lanza ante una key desconocida', () => {
    expect(() => getPolicyDef('no.existe' as PolicyKey)).toThrow();
  });
});

describe('DefaultPolicyReader — devuelve los defaults', () => {
  const reader = new DefaultPolicyReader();

  it('getEnabled refleja defaultEnabled del catálogo', async () => {
    await expect(reader.getEnabled('auth.mfa')).resolves.toBe(true); // mandatory
    await expect(reader.getEnabled('access.jit')).resolves.toBe(false); // NET-NEW
  });

  it('number devuelve el default del param (no el fallback)', async () => {
    await expect(reader.number('auth.stepup', 'maxAgeSec', 999)).resolves.toBe(300);
    await expect(reader.number('media.retention', 'days', 999)).resolves.toBe(30);
    await expect(reader.number('privacy.erasure', 'graceDays', 999)).resolves.toBe(30);
    await expect(reader.number('media.dual-auth', 'approvers', 999)).resolves.toBe(2);
  });

  it('number cae al fallback cuando el param no existe', async () => {
    await expect(reader.number('auth.mfa', 'inexistente', 42)).resolves.toBe(42);
  });

  it('list devuelve la lista del default o el fallback', async () => {
    await expect(reader.list('access.ip-allowlist', 'cidrs', ['x'])).resolves.toEqual([]);
    await expect(reader.list('pii.mask', 'revealRoles', [])).resolves.toEqual([
      'COMPLIANCE',
      'SUPERADMIN',
    ]);
    await expect(reader.list('auth.stepup', 'noEsLista', ['fb'])).resolves.toEqual(['fb']);
  });

  it('bool cae al fallback cuando el param no es booleano', async () => {
    await expect(reader.bool('auth.stepup', 'maxAgeSec', true)).resolves.toBe(true);
  });

  it('params devuelve el objeto de defaults completo', async () => {
    await expect(reader.params('media.dual-auth')).resolves.toEqual({ approvers: 2 });
  });

  it('DEFAULT_PARAMS devuelve una copia (no la referencia interna)', () => {
    const a = DEFAULT_PARAMS('access.ip-allowlist');
    expect(a).toEqual({ cidrs: [] });
    expect(a).not.toBe(POLICY_CATALOG['access.ip-allowlist'].defaults);
  });
});
