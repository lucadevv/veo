import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthService } from './auth.service';
import type { IdentityAuthClient } from './identity-auth.client';
import type { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser, PolicyReaderPort } from '@veo/auth';
import type { AuditRecorder } from '../audit/audit-recorder.service';

/**
 * Construye el service. `policy` opcional: sin él (default) NO hay overlay → `hiddenPermissions` cae a `[]`
 * (fail-safe). Con un stub `isPermissionHiddenSync` se simula un override RESTADO para probar el cómputo.
 */
function makeService(policy?: Partial<PolicyReaderPort>): AuthService {
  return new AuthService(
    {} as unknown as IdentityAuthClient,
    {} as unknown as AuditRecorder,
    {} as unknown as InternalRestClient,
    policy as PolicyReaderPort | undefined,
  );
}

const baseUser: AuthenticatedUser = {
  userId: 'u1',
  type: 'admin',
  roles: ['ADMIN'],
  sessionId: 's1',
};

describe('AuthService.session — mfaFresh', () => {
  afterEach(() => vi.unstubAllEnvs());

  // DEV/local (NO endurecido): el `StepUpMfaGuard` bypassea la doble-auth fresca (`if (!isHardenedEnv())
  // return true`), así que el indicador `mfaFresh` debe reflejar ESO — siempre `true` — y NO mentir sobre
  // un gate que el server no aplica en dev. El gate de ROL sigue protegiendo en TODOS los entornos.
  describe('en dev/local (no endurecido)', () => {
    it('mfaFresh=true aunque NO haya verificación MFA (el server no exige step-up en dev)', () => {
      expect(makeService().session(baseUser).mfaFresh).toBe(true);
    });

    it('mfaFresh=true aunque la verificación MFA sea vieja', () => {
      const oldSec = Math.floor(Date.now() / 1000) - 3600;
      expect(makeService().session({ ...baseUser, mfaVerifiedAt: oldSec }).mfaFresh).toBe(true);
    });

    it('la sesión proyecta la forma esperada (userId/type/roles/mfaFresh/hiddenPermissions)', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      expect(makeService().session({ ...baseUser, mfaVerifiedAt: nowSec })).toEqual({
        userId: 'u1',
        type: 'admin',
        roles: ['ADMIN'],
        mfaFresh: true,
        hiddenPermissions: [],
      });
    });
  });

  // ENDURECIDO (NODE_ENV=production → preview Y prod, internet-facing): el `StepUpMfaGuard` SÍ exige la
  // doble-auth fresca, así que `mfaFresh` sigue la ventana real de frescura (300s) de `isMfaFresh`.
  describe('en producción (endurecido)', () => {
    beforeEach(() => vi.stubEnv('NODE_ENV', 'production'));

    it('mfaFresh=true cuando la verificación MFA es reciente (<=300s)', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      expect(makeService().session({ ...baseUser, mfaVerifiedAt: nowSec }).mfaFresh).toBe(true);
    });

    it('mfaFresh=false cuando no hay verificación MFA', () => {
      expect(makeService().session(baseUser).mfaFresh).toBe(false);
    });

    it('mfaFresh=false cuando la verificación MFA es vieja', () => {
      const oldSec = Math.floor(Date.now() / 1000) - 3600;
      expect(makeService().session({ ...baseUser, mfaVerifiedAt: oldSec }).mfaFresh).toBe(false);
    });
  });
});

// OVERLAY de visibilidad (ADR-025 §3 · Fase 2): la sesión expone `hiddenPermissions` = los permisos que el
// overlay le RESTA al actor, con la MISMA fórmula del efectivo que enforcea el PermissionOverlayGuard. El front
// los usa para OCULTAR nav/botones/páginas (compone base ∧ ¬oculto en can()).
describe('AuthService.session — hiddenPermissions (overlay)', () => {
  it('sin PolicyReader (fail-safe) → hiddenPermissions vacío (rige la base pura)', () => {
    expect(makeService().session(baseUser).hiddenPermissions).toEqual([]);
  });

  it('lista un permiso que el overlay RESTA al rol del actor (base lo concede)', () => {
    // ADMIN tiene `operators:view` en base; el overlay lo resta a ADMIN → aparece en hiddenPermissions.
    const policy: Partial<PolicyReaderPort> = {
      isPermissionHiddenSync: (role, permission) =>
        role === 'ADMIN' && permission === 'operators:view',
    };
    const hidden = makeService(policy).session(baseUser).hiddenPermissions;
    expect(hidden).toContain('operators:view');
    // No colapsa otros permisos base de ADMIN (ej. ops:view sigue efectivo).
    expect(hidden).not.toContain('ops:view');
  });

  it('NO lista un permiso que la base NO concede al actor (nunca lo tuvo)', () => {
    // `finance:payout` NO es base de ADMIN (solo FINANCE). Aunque el stub lo "restara", no es oculto: nunca lo tuvo.
    const policy: Partial<PolicyReaderPort> = { isPermissionHiddenSync: () => true };
    const hidden = makeService(policy).session(baseUser).hiddenPermissions ?? [];
    expect(hidden).not.toContain('finance:payout');
  });

  it('multi-rol: solo es oculto si TODOS los roles que lo conceden lo tienen restado (OR permisivo)', () => {
    // FINANCE+ADMIN comparten `finance:view` en base. Restarlo SOLO a FINANCE → sigue efectivo por ADMIN → NO oculto.
    const multiRole: AuthenticatedUser = { ...baseUser, roles: ['FINANCE', 'ADMIN'] };
    const onlyFinanceHidden: Partial<PolicyReaderPort> = {
      isPermissionHiddenSync: (role, permission) =>
        role === 'FINANCE' && permission === 'finance:view',
    };
    expect(makeService(onlyFinanceHidden).session(multiRole).hiddenPermissions).not.toContain(
      'finance:view',
    );
    // Restarlo a AMBOS roles → ya nadie lo conserva → oculto.
    const bothHidden: Partial<PolicyReaderPort> = {
      isPermissionHiddenSync: (_role, permission) => permission === 'finance:view',
    };
    expect(makeService(bothHidden).session(multiRole).hiddenPermissions).toContain('finance:view');
  });
});
