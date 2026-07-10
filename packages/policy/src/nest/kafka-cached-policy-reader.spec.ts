import { describe, it, expect } from 'vitest';
import { KafkaCachedPolicyReader } from './kafka-cached-policy-reader.js';
import type { PolicyRegistryPort, PolicyView } from './registry.js';

/** Fila `PolicyView` completa a partir de un parche (defaults cómodos para los tests). */
function view(partial: Partial<PolicyView> & { key: string }): PolicyView {
  return {
    family: 'auth',
    enabled: true,
    params: {},
    mandatory: false,
    version: 1,
    updatedBy: 'op1',
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...partial,
  };
}

/** Doble en memoria del registro: una lista fija, o un factory (para simular un fallo de red). */
function registry(rows: PolicyView[] | (() => Promise<PolicyView[]>)): PolicyRegistryPort {
  return { list: typeof rows === 'function' ? rows : () => Promise.resolve(rows) };
}

describe('KafkaCachedPolicyReader — cache + fail-safe (ADR-024 §2/§4)', () => {
  it('carga inicial: puebla el cache con las políticas del registro', async () => {
    const reader = new KafkaCachedPolicyReader(
      registry([view({ key: 'auth.stepup', params: { maxAgeSec: 120 } })]),
    );
    await reader.loadInitial();

    await expect(reader.number('auth.stepup', 'maxAgeSec', 300)).resolves.toBe(120);
    expect(reader.numberSync('auth.stepup', 'maxAgeSec', 300)).toBe(120);
  });

  it('un policy.updated actualiza la key en el cache (frescura inmediata, sin TTL)', async () => {
    const reader = new KafkaCachedPolicyReader(
      registry([view({ key: 'auth.stepup', params: { maxAgeSec: 120 } })]),
    );
    await reader.loadInitial();

    reader.applyEvent({ key: 'auth.stepup', enabled: true, params: { maxAgeSec: 45 }, version: 2 });

    await expect(reader.number('auth.stepup', 'maxAgeSec', 300)).resolves.toBe(45);
    expect(reader.numberSync('auth.stepup', 'maxAgeSec', 300)).toBe(45);
  });

  it('un evento FUERA DE ORDEN (version menor) NO pisa el cache', async () => {
    const reader = new KafkaCachedPolicyReader(
      registry([view({ key: 'auth.stepup', params: { maxAgeSec: 45 }, version: 5 })]),
    );
    await reader.loadInitial();

    reader.applyEvent({ key: 'auth.stepup', enabled: true, params: { maxAgeSec: 999 }, version: 2 });

    expect(reader.numberSync('auth.stepup', 'maxAgeSec', 300)).toBe(45);
  });

  it('applyEvent ignora una key desconocida (no rompe el cache)', async () => {
    const reader = new KafkaCachedPolicyReader(registry([]));
    await reader.loadInitial();

    reader.applyEvent({ key: 'no.existe', enabled: true, params: { x: 1 }, version: 9 });

    // La key ajena no entra; una key real sigue cayendo a su default.
    await expect(reader.number('auth.stepup', 'maxAgeSec', 999)).resolves.toBe(300);
  });

  it('key AUSENTE del cache cae al DEFAULT del catálogo (nunca fail-open)', async () => {
    const reader = new KafkaCachedPolicyReader(registry([]));
    await reader.loadInitial();

    await expect(reader.number('auth.stepup', 'maxAgeSec', 999)).resolves.toBe(300); // default real
    await expect(reader.number('media.retention', 'days', 999)).resolves.toBe(30);
    await expect(reader.getEnabled('auth.mfa')).resolves.toBe(true); // mandatory
    await expect(reader.getEnabled('access.jit')).resolves.toBe(false); // NET-NEW
    await expect(reader.list('pii.mask', 'revealRoles', [])).resolves.toEqual([
      'COMPLIANCE',
      'SUPERADMIN',
    ]);
    await expect(reader.params('media.dual-auth')).resolves.toEqual({ approvers: 2 });
  });

  it('param AUSENTE en una key cacheada cae al DEFAULT del catálogo', async () => {
    const reader = new KafkaCachedPolicyReader(
      registry([view({ key: 'auth.stepup', params: {} })]), // fila sin el param
    );
    await reader.loadInitial();

    await expect(reader.number('auth.stepup', 'maxAgeSec', 777)).resolves.toBe(300);
    expect(reader.numberSync('auth.stepup', 'maxAgeSec', 777)).toBe(300);
  });

  it('identity INALCANZABLE en el boot → DEFAULTS, SIN throw (fail-safe)', async () => {
    const reader = new KafkaCachedPolicyReader(
      registry(() => Promise.reject(new Error('ECONNREFUSED'))),
    );

    await expect(reader.loadInitial()).resolves.toBeUndefined(); // no revienta el boot
    await expect(reader.number('auth.stepup', 'maxAgeSec', 999)).resolves.toBe(300);
    expect(reader.numberSync('auth.stepup', 'maxAgeSec', 999)).toBe(300);
  });

  it('numberSync de una key desconocida devuelve el fallback (nunca fail-open)', () => {
    const reader = new KafkaCachedPolicyReader(registry([]));
    expect(reader.numberSync('no.existe', 'x', 555)).toBe(555);
  });
});
