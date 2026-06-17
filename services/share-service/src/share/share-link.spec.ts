import { describe, it, expect } from 'vitest';
import { ForbiddenError, UnauthorizedError, uuidv7 } from '@veo/utils';
import {
  signShareToken,
  verifyShareToken,
  tokenHashOf,
  assertShareLinkUsable,
  type ShareLinkState,
} from './share-link';

const SECRET = 'test-share-secret';

describe('share-link · firma y verificación (BR-S05)', () => {
  it('firma y verifica un token válido (round-trip)', () => {
    const shareId = uuidv7();
    const expiresAtMs = Date.now() + 60_000;
    const { token, tokenHash } = signShareToken(shareId, expiresAtMs, SECRET);

    expect(tokenHash).toBe(tokenHashOf(token));
    const claims = verifyShareToken(token, SECRET);
    expect(claims.shareId).toBe(shareId);
    expect(claims.expiresAtMs).toBe(expiresAtMs);
  });

  it('nunca expone el token en claro: solo se guarda el hash', () => {
    const { token, tokenHash } = signShareToken(uuidv7(), Date.now() + 60_000, SECRET);
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rechaza un token manipulado (firma inválida)', () => {
    const { token } = signShareToken(uuidv7(), Date.now() + 60_000, SECRET);
    const tampered = `${token}00`;
    expect(() => verifyShareToken(tampered, SECRET)).toThrow(UnauthorizedError);
  });

  it('rechaza un token firmado con otro secreto', () => {
    const { token } = signShareToken(uuidv7(), Date.now() + 60_000, SECRET);
    expect(() => verifyShareToken(token, 'otro-secreto')).toThrow(UnauthorizedError);
  });

  it('rechaza un token malformado', () => {
    expect(() => verifyShareToken('basura', SECRET)).toThrow(UnauthorizedError);
    expect(() => verifyShareToken('', SECRET)).toThrow(UnauthorizedError);
  });

  it('rechaza un token expirado (expiración)', () => {
    const shareId = uuidv7();
    const expiresAtMs = Date.now() - 1; // ya expirado
    const { token } = signShareToken(shareId, expiresAtMs, SECRET);
    expect(() => verifyShareToken(token, SECRET)).toThrow(ForbiddenError);
  });

  it('respeta el parámetro `now` al evaluar la expiración', () => {
    const shareId = uuidv7();
    const expiresAtMs = 10_000;
    const { token } = signShareToken(shareId, expiresAtMs, SECRET);
    expect(verifyShareToken(token, SECRET, 9_999).shareId).toBe(shareId);
    expect(() => verifyShareToken(token, SECRET, 10_001)).toThrow(ForbiddenError);
  });
});

describe('share-link · estado autoritativo (BD)', () => {
  const base: ShareLinkState = {
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    usedCount: 0,
    maxUses: 3,
  };

  it('acepta un enlace vigente con usos disponibles', () => {
    expect(() => assertShareLinkUsable(base)).not.toThrow();
  });

  it('rechaza un enlace revocado', () => {
    expect(() => assertShareLinkUsable({ ...base, revokedAt: new Date() })).toThrow(ForbiddenError);
  });

  it('rechaza un enlace expirado', () => {
    expect(() => assertShareLinkUsable({ ...base, expiresAt: new Date(Date.now() - 1) })).toThrow(
      ForbiddenError,
    );
  });

  it('rechaza un enlace que agotó sus usos', () => {
    expect(() => assertShareLinkUsable({ ...base, usedCount: 3, maxUses: 3 })).toThrow(
      ForbiddenError,
    );
  });
});
