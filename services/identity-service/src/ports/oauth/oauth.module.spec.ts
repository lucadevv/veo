import { describe, it, expect } from 'vitest';
import { UnauthorizedError } from '@veo/utils';
import { OAuthSandboxVerifier } from './oauth.module';

/** Construye un id_token de fixture: el payload JSON codificado base64url (sin firma). */
function fixtureToken(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('OAuthSandboxVerifier', () => {
  const verifier = new OAuthSandboxVerifier();

  it('decodifica el fixture base64url y mapea sub/email/email_verified/name', async () => {
    const token = fixtureToken({
      sub: 'google-sub-123',
      email: 'Ada@Veo.PE',
      email_verified: true,
      name: 'Ada Lovelace',
    });
    const out = await verifier.verifyGoogleIdToken(token);
    expect(out).toEqual({
      sub: 'google-sub-123',
      email: 'Ada@Veo.PE',
      emailVerified: true,
      name: 'Ada Lovelace',
    });
  });

  it('email_verified ausente → emailVerified=false; email/name ausentes → null', async () => {
    const token = fixtureToken({ sub: 'sub-no-email' });
    const out = await verifier.verifyGoogleIdToken(token);
    expect(out).toEqual({ sub: 'sub-no-email', email: null, emailVerified: false, name: null });
  });

  it('acepta email_verified como string "true"', async () => {
    const token = fixtureToken({ sub: 'sub-x', email_verified: 'true' });
    const out = await verifier.verifyGoogleIdToken(token);
    expect(out.emailVerified).toBe(true);
  });

  it('token no decodificable (base64url inválido / no-JSON) → UnauthorizedError', async () => {
    await expect(verifier.verifyGoogleIdToken('!!! not base64 json !!!')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('payload sin sub → UnauthorizedError', async () => {
    const token = fixtureToken({ email: 'x@veo.pe', email_verified: true });
    await expect(verifier.verifyGoogleIdToken(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  describe('verifyAppleIdToken', () => {
    it('decodifica el fixture base64url y mapea sub/email/email_verified; name SIEMPRE null', async () => {
      const token = fixtureToken({
        sub: 'apple-sub-123',
        email: 'Relay@privaterelay.appleid.com',
        email_verified: true,
      });
      const out = await verifier.verifyAppleIdToken(token);
      expect(out).toEqual({
        sub: 'apple-sub-123',
        email: 'Relay@privaterelay.appleid.com',
        emailVerified: true,
        name: null, // Apple no manda el nombre en el token
      });
    });

    it('login posterior sin email (Apple solo lo manda la 1ra vez) → email=null, sub presente', async () => {
      const token = fixtureToken({ sub: 'apple-sub-relogin' });
      const out = await verifier.verifyAppleIdToken(token);
      expect(out).toEqual({
        sub: 'apple-sub-relogin',
        email: null,
        emailVerified: false,
        name: null,
      });
    });

    it('acepta email_verified como string "true"', async () => {
      const token = fixtureToken({ sub: 'apple-x', email_verified: 'true' });
      const out = await verifier.verifyAppleIdToken(token);
      expect(out.emailVerified).toBe(true);
    });

    it('token no decodificable → UnauthorizedError', async () => {
      await expect(verifier.verifyAppleIdToken('!!! not base64 json !!!')).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    });

    it('payload sin sub → UnauthorizedError', async () => {
      const token = fixtureToken({ email: 'x@privaterelay.appleid.com', email_verified: true });
      await expect(verifier.verifyAppleIdToken(token)).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });
});
