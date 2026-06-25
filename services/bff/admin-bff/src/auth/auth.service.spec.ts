import { describe, it, expect } from 'vitest';
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

describe('AuthService.session', () => {
  it('mfaFresh=true cuando la verificación MFA es reciente (<=300s)', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const out = makeService().session({ ...baseUser, mfaVerifiedAt: nowSec });
    expect(out).toEqual({ userId: 'u1', type: 'admin', roles: ['ADMIN'], mfaFresh: true });
  });

  it('mfaFresh=false cuando no hay verificación MFA', () => {
    expect(makeService().session(baseUser).mfaFresh).toBe(false);
  });

  it('mfaFresh=false cuando la verificación MFA es vieja', () => {
    const oldSec = Math.floor(Date.now() / 1000) - 3600;
    expect(makeService().session({ ...baseUser, mfaVerifiedAt: oldSec }).mfaFresh).toBe(false);
  });
});
