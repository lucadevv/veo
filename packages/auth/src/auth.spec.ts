import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { JwtService, type JwtKeys } from './jwt.js';
import {
  signInternalIdentity,
  verifyInternalIdentity,
  isInternalAudience,
  INTERNAL_AUDIENCES,
} from './internal-identity.js';
import { assertDriverOwnsResource } from './ownership.js';
import type { AuthenticatedUser } from './jwt.js';
import { ForbiddenError, signHmac } from '@veo/utils';
import { enrollTotp, verifyTotp, isMfaFresh } from './totp.js';
import { authenticator } from 'otplib';
import { RedisRefreshTokenStore, RefreshError } from './refresh-store.js';
import { SessionRevocationStore } from './session-revocation.js';

let keys: JwtKeys;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  keys = {
    privatePem: await exportPKCS8(privateKey),
    publicPem: await exportSPKI(publicKey),
    issuer: 'veo',
    audience: 'veo-app',
    accessTtl: '15m',
    refreshTtl: '30d',
  };
});

describe('JwtService (ES256)', () => {
  it('firma y verifica access token con claims', async () => {
    const jwt = new JwtService(keys);
    const token = await jwt.signAccessToken({
      sub: 'u1',
      typ: 'admin',
      roles: ['FINANCE'],
      sid: 's1',
      mfaAt: 1000,
    });
    const claims = await jwt.verifyAccess(token);
    expect(claims.sub).toBe('u1');
    expect(claims.roles).toEqual(['FINANCE']);
    expect(claims.sid).toBe('s1');
  });
  it('rechaza token corrupto', async () => {
    const jwt = new JwtService(keys);
    await expect(jwt.verifyAccess('not.a.token')).rejects.toThrow();
  });

  it('firma y verifica refresh token portando typ (para repoblar autorización en refresh)', async () => {
    const jwt = new JwtService(keys);
    const token = await jwt.signRefreshToken({ sub: 'a1', sid: 's1', jti: 'j1', typ: 'admin' });
    const claims = await jwt.verifyRefresh(token);
    expect(claims.sub).toBe('a1');
    expect(claims.sid).toBe('s1');
    expect(claims.jti).toBe('j1');
    expect(claims.typ).toBe('admin');
  });

  it('refresh token sin typ verifica con typ undefined (backward-compat tokens viejos)', async () => {
    const jwt = new JwtService(keys);
    const token = await jwt.signRefreshToken({ sub: 'u1', sid: 's1', jti: 'j1' });
    const claims = await jwt.verifyRefresh(token);
    expect(claims.typ).toBeUndefined();
  });
});

describe('identidad interna BFF→servicio', () => {
  it('firma y verifica con HMAC', () => {
    const user = { userId: 'u1', type: 'passenger' as const, roles: [], sessionId: 's1' };
    const { header, signature } = signInternalIdentity(user, 'internal-secret', 'public-rail');
    const verified = verifyInternalIdentity(header, signature, 'internal-secret');
    expect(verified?.userId).toBe('u1');
    expect(verified?.aud).toBe('public-rail');
  });
  it('rechaza firma inválida y secreto incorrecto', () => {
    const user = { userId: 'u1', type: 'driver' as const, roles: [], sessionId: 's1' };
    const { header, signature } = signInternalIdentity(user, 'internal-secret', 'driver-rail');
    expect(verifyInternalIdentity(header, signature, 'otro-secret')).toBeNull();
    expect(verifyInternalIdentity(header, 'deadbeef', 'internal-secret')).toBeNull();
  });
});

describe('audience scoping de identidad interna (fail-closed)', () => {
  const user = { userId: 'u1', type: 'passenger' as const, roles: [], sessionId: 's1' };

  it('acepta cuando la audiencia firmada ∈ las audiencias permitidas', () => {
    const { header, signature } = signInternalIdentity(user, 'sec', 'public-rail');
    const verified = verifyInternalIdentity(header, signature, 'sec', {
      allowedAudiences: ['public-rail', 'service-rail'],
    });
    expect(verified?.aud).toBe('public-rail');
  });

  it('RECHAZA cuando la audiencia firmada NO está permitida (riel ajeno)', () => {
    const { header, signature } = signInternalIdentity(user, 'sec', 'public-rail');
    // Un servicio admin-only no debe aceptar una identidad firmada por el riel público.
    const verified = verifyInternalIdentity(header, signature, 'sec', {
      allowedAudiences: ['admin-rail'],
    });
    expect(verified).toBeNull();
  });

  it('RECHAZA (fail-closed) una identidad sin claim aud cuando se exigen audiencias', () => {
    // Header forjado SIN aud pero con HMAC válido (simula un emisor legacy/atacante con el secreto).
    const legacy = { userId: 'u1', type: 'passenger', roles: [], sessionId: 's1', issuedAt: Date.now() };
    const header = Buffer.from(JSON.stringify(legacy)).toString('base64url');
    const signature = signHmac(header, 'sec');
    const verified = verifyInternalIdentity(header, signature, 'sec', {
      allowedAudiences: ['public-rail'],
    });
    expect(verified).toBeNull();
  });

  it('sin allowedAudiences (legacy/test) no verifica audiencia — backward-compat', () => {
    const { header, signature } = signInternalIdentity(user, 'sec', 'driver-rail');
    expect(verifyInternalIdentity(header, signature, 'sec')?.aud).toBe('driver-rail');
  });

  it('isInternalAudience reconoce solo las audiencias conocidas', () => {
    for (const a of INTERNAL_AUDIENCES) expect(isInternalAudience(a)).toBe(true);
    expect(isInternalAudience('hacker-rail')).toBe(false);
    expect(isInternalAudience(undefined)).toBe(false);
  });
});

describe('assertDriverOwnsResource (anti-IDOR)', () => {
  const driver = (driverId?: string): AuthenticatedUser => ({
    userId: 'u1',
    type: 'driver',
    roles: [],
    sessionId: 's1',
    driverId,
  });

  it('permite a un conductor leer SU propio driverId', () => {
    expect(() => assertDriverOwnsResource(driver('drv-1'), 'drv-1')).not.toThrow();
  });

  it('rechaza (403) a un conductor que pide el driverId de otro', () => {
    expect(() => assertDriverOwnsResource(driver('drv-1'), 'drv-2')).toThrow(ForbiddenError);
  });

  it('rechaza (403, fail-closed) si la identidad de conductor no trae driverId firmado', () => {
    expect(() => assertDriverOwnsResource(driver(undefined), 'drv-1')).toThrow(ForbiddenError);
  });

  it('no aplica a identidades admin (gobernadas por RBAC en su propio camino)', () => {
    const admin: AuthenticatedUser = {
      userId: 'a1',
      type: 'admin',
      roles: ['FINANCE'],
      sessionId: 's1',
    };
    expect(() => assertDriverOwnsResource(admin, 'cualquier-driver')).not.toThrow();
  });

  it('rechaza (403) si no hay identidad', () => {
    expect(() => assertDriverOwnsResource(undefined, 'drv-1')).toThrow(ForbiddenError);
  });
});

describe('TOTP step-up', () => {
  it('enrola y verifica un código válido', () => {
    const { secret } = enrollTotp('ana@veo.pe');
    const code = authenticator.generate(secret);
    expect(verifyTotp(code, secret)).toBe(true);
    expect(verifyTotp('000000', secret)).toBe(false);
  });
  it('evalúa frescura de MFA', () => {
    const now = Date.now() / 1000;
    expect(isMfaFresh(now - 60, 300)).toBe(true);
    expect(isMfaFresh(now - 600, 300)).toBe(false);
    expect(isMfaFresh(undefined)).toBe(false);
  });
});

describe('RedisRefreshTokenStore (rotación + reuse detection)', () => {
  function fakeRedis() {
    const store = new Map<string, string>();
    return {
      async set(k: string, v: string) {
        store.set(k, v);
        return 'OK';
      },
      async get(k: string) {
        return store.get(k) ?? null;
      },
      async del(...ks: string[]) {
        let n = 0;
        for (const k of ks) if (store.delete(k)) n++;
        return n;
      },
      async exists(k: string) {
        return store.has(k) ? 1 : 0;
      },
    };
  }

  it('rota el refresh y detecta reuse de un token viejo', async () => {
    const store = new RedisRefreshTokenStore(fakeRedis() as any, 2_592_000);
    const { sessionId, newJti } = await store.createSession('u1');
    expect(await store.isValid(sessionId)).toBe(true);

    const rotated = await store.rotate(sessionId, newJti);
    expect(rotated.newJti).not.toBe(newJti);

    // Reusar el jti viejo (robado) → mata la sesión.
    await expect(store.rotate(sessionId, newJti)).rejects.toBeInstanceOf(RefreshError);
    expect(await store.isValid(sessionId)).toBe(false);
  });

  it('revoca una sesión al instante', async () => {
    const store = new RedisRefreshTokenStore(fakeRedis() as any, 100);
    const { sessionId } = await store.createSession('u2');
    await store.revoke(sessionId);
    expect(await store.isValid(sessionId)).toBe(false);
  });
});

describe('SessionRevocationStore (denylist de revocación server-side)', () => {
  // Fake que soporta lo que usa el denylist: set (con EX) y mget. Comparte Map con el refresh-store.
  function fakeRedis() {
    const store = new Map<string, string>();
    return {
      store,
      async set(k: string, v: string) {
        store.set(k, v);
        return 'OK';
      },
      async mget(...ks: string[]) {
        return ks.map((k) => store.get(k) ?? null);
      },
      async get(k: string) {
        return store.get(k) ?? null;
      },
      async del(...ks: string[]) {
        let n = 0;
        for (const k of ks) if (store.delete(k)) n++;
        return n;
      },
      async exists(k: string) {
        return store.has(k) ? 1 : 0;
      },
      // Minimal: revokeAllForUser barre las sesiones con este stream antes de sellar revoked-before.
      scanStream({ match }: { match: string }) {
        const prefix = match.replace(/\*$/, '');
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
        return (async function* () {
          yield keys;
        })();
      },
    };
  }

  it('per-sid: revokeSession → el token de ese sid queda revocado', async () => {
    const rev = new SessionRevocationStore(fakeRedis() as any);
    expect(await rev.isRevoked({ sub: 'u1', sid: 'sess-1', iat: 100 })).toBeNull();
    await rev.revokeSession('sess-1');
    expect(await rev.isRevoked({ sub: 'u1', sid: 'sess-1', iat: 100 })).toBe('session-revoked');
  });

  it('revoked-before: rechaza tokens con iat ANTERIOR, deja pasar el iat posterior (strict <)', async () => {
    const rev = new SessionRevocationStore(fakeRedis() as any);
    await rev.revokeAllForUser('u1');
    const nowSec = Math.floor(Date.now() / 1000);
    // Token VIEJO (emitido antes del revoke) → superado.
    expect(await rev.isRevoked({ sub: 'u1', sid: 's', iat: nowSec - 2 })).toBe('sessions-superseded');
    // Token NUEVO (emitido después del revoke, iat mayor) → pasa. Esto es el login single-session.
    expect(await rev.isRevoked({ sub: 'u1', sid: 's', iat: nowSec + 2 })).toBeNull();
    // Otro user no se ve afectado por el revoke de u1.
    expect(await rev.isRevoked({ sub: 'u2', sid: 's', iat: nowSec - 2 })).toBeNull();
  });

  it('sin iat: el eje revoked-before no aplica (no evaluable) → no revoca', async () => {
    const rev = new SessionRevocationStore(fakeRedis() as any);
    await rev.revokeAllForUser('u1');
    expect(await rev.isRevoked({ sub: 'u1', sid: 's' })).toBeNull();
  });

  it('fail-OPEN: si Redis lanza en el check, degrada a NO-revocado (no tumba el riel)', async () => {
    const brokenRedis = {
      async mget() {
        throw new Error('redis down');
      },
    };
    const rev = new SessionRevocationStore(brokenRedis as any);
    expect(await rev.isRevoked({ sub: 'u1', sid: 's', iat: 1 })).toBeNull();
  });

  it('integración: RedisRefreshTokenStore.revoke sella el denylist por-sid', async () => {
    const fake = fakeRedis();
    const rev = new SessionRevocationStore(fake as any);
    const store = new RedisRefreshTokenStore(fake as any, 100, rev);
    const { sessionId } = await store.createSession('u9');
    await store.revoke(sessionId);
    expect(await rev.isRevoked({ sub: 'u9', sid: sessionId, iat: 123 })).toBe('session-revoked');
  });

  it('integración: RedisRefreshTokenStore.revokeAllForUser sella revoked-before', async () => {
    const fake = fakeRedis();
    const rev = new SessionRevocationStore(fake as any);
    const store = new RedisRefreshTokenStore(fake as any, 100, rev);
    await store.createSession('u9');
    await store.revokeAllForUser('u9');
    const nowSec = Math.floor(Date.now() / 1000);
    expect(await rev.isRevoked({ sub: 'u9', sid: 'any', iat: nowSec - 2 })).toBe(
      'sessions-superseded',
    );
  });
});
