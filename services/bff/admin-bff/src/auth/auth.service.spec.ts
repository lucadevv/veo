import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthService } from './auth.service';
import type { IdentityAuthClient } from './identity-auth.client';
import type { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type { AuditRecorder } from '../audit/audit-recorder.service';

function makeService(): AuthService {
  return new AuthService(
    {} as unknown as IdentityAuthClient,
    {} as unknown as AuditRecorder,
    {} as unknown as InternalRestClient,
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

    it('la sesión proyecta la forma esperada (userId/type/roles/mfaFresh)', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      expect(makeService().session({ ...baseUser, mfaVerifiedAt: nowSec })).toEqual({
        userId: 'u1',
        type: 'admin',
        roles: ['ADMIN'],
        mfaFresh: true,
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
