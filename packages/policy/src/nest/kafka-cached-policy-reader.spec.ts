import { describe, it, expect } from 'vitest';
import { KafkaCachedPolicyReader } from './kafka-cached-policy-reader.js';
import type { PermissionOverrideView, PolicyRegistryPort, PolicyView } from './registry.js';

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

/** Fila `PermissionOverrideView` completa a partir de un parche. */
function ov(
  partial: Partial<PermissionOverrideView> & { role: string; permission: string },
): PermissionOverrideView {
  return {
    hidden: true,
    version: 1,
    updatedBy: 'sup1',
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...partial,
  };
}

/**
 * Doble en memoria del registro. `rows` = políticas (lista fija o factory para simular fallo). `overrides`
 * = overlay (default: endpoint AUSENTE → rechaza, como en la Ola 1 antes de que identity lo exponga).
 */
function registry(
  rows: PolicyView[] | (() => Promise<PolicyView[]>),
  overrides: PermissionOverrideView[] | (() => Promise<PermissionOverrideView[]>) = () =>
    Promise.reject(new Error('404 /internal/permission-overrides')),
): PolicyRegistryPort {
  return {
    list: typeof rows === 'function' ? rows : () => Promise.resolve(rows),
    listOverrides: typeof overrides === 'function' ? overrides : () => Promise.resolve(overrides),
  };
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

describe('KafkaCachedPolicyReader — OVERLAY de permisos (ADR-025 §3)', () => {
  it('sin overrides cargados → isPermissionHidden es false (rige la base)', async () => {
    const reader = new KafkaCachedPolicyReader(registry([], []));
    await reader.loadOverrides();

    await expect(reader.isPermissionHidden('DISPATCHER', 'drivers:approve')).resolves.toBe(false);
    expect(reader.isPermissionHiddenSync('DISPATCHER', 'drivers:approve')).toBe(false);
  });

  it('carga inicial: puebla el overlay con los pares restados del registro', async () => {
    const reader = new KafkaCachedPolicyReader(
      registry([], [ov({ role: 'DISPATCHER', permission: 'drivers:approve', hidden: true })]),
    );
    await reader.loadOverrides();

    await expect(reader.isPermissionHidden('DISPATCHER', 'drivers:approve')).resolves.toBe(true);
    expect(reader.isPermissionHiddenSync('DISPATCHER', 'drivers:approve')).toBe(true);
    // Un par NO restado sigue en false.
    expect(reader.isPermissionHiddenSync('DISPATCHER', 'ops:view')).toBe(false);
  });

  it('un permission_override.updated hidden=true RESTA el par (frescura inmediata)', async () => {
    const reader = new KafkaCachedPolicyReader(registry([], []));
    await reader.loadOverrides();
    expect(reader.isPermissionHiddenSync('FINANCE', 'ops:view')).toBe(false);

    reader.applyOverrideEvent({ role: 'FINANCE', permission: 'ops:view', hidden: true, version: 2 });

    await expect(reader.isPermissionHidden('FINANCE', 'ops:view')).resolves.toBe(true);
    expect(reader.isPermissionHiddenSync('FINANCE', 'ops:view')).toBe(true);
  });

  it('un permission_override.updated hidden=false DES-RESTAURA el par (vuelve la base)', async () => {
    const reader = new KafkaCachedPolicyReader(
      registry([], [ov({ role: 'FINANCE', permission: 'ops:view', hidden: true, version: 1 })]),
    );
    await reader.loadOverrides();
    expect(reader.isPermissionHiddenSync('FINANCE', 'ops:view')).toBe(true);

    reader.applyOverrideEvent({ role: 'FINANCE', permission: 'ops:view', hidden: false, version: 2 });

    expect(reader.isPermissionHiddenSync('FINANCE', 'ops:view')).toBe(false);
  });

  it('un override FUERA DE ORDEN (version menor) NO pisa el overlay', async () => {
    const reader = new KafkaCachedPolicyReader(
      registry([], [ov({ role: 'FINANCE', permission: 'ops:view', hidden: true, version: 5 })]),
    );
    await reader.loadOverrides();

    reader.applyOverrideEvent({ role: 'FINANCE', permission: 'ops:view', hidden: false, version: 2 });

    expect(reader.isPermissionHiddenSync('FINANCE', 'ops:view')).toBe(true); // sigue restado
  });

  it('endpoint de overrides AUSENTE/inalcanzable en el boot → overlay vacío, SIN throw (fail-safe)', async () => {
    const reader = new KafkaCachedPolicyReader(registry([])); // overrides default: rechaza (404)

    await expect(reader.loadOverrides()).resolves.toBeUndefined(); // no revienta el boot
    expect(reader.isPermissionHiddenSync('DISPATCHER', 'drivers:approve')).toBe(false); // no resta nada
  });

  it('onModuleInit carga políticas Y overlay (ambos fail-safe si el registro falla)', async () => {
    const reader = new KafkaCachedPolicyReader(
      registry(
        [view({ key: 'auth.stepup', params: { maxAgeSec: 120 } })],
        [ov({ role: 'DISPATCHER', permission: 'drivers:approve', hidden: true })],
      ),
    );
    await reader.onModuleInit();

    expect(reader.numberSync('auth.stepup', 'maxAgeSec', 300)).toBe(120);
    expect(reader.isPermissionHiddenSync('DISPATCHER', 'drivers:approve')).toBe(true);
  });
});
