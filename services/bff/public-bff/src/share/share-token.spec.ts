/** Tests de la decodificación del token de seguimiento (sin secreto; solo lee el cuerpo). */
import { describe, it, expect } from 'vitest';
import { ValidationError } from '@veo/utils';
import { parseShareToken, shareTokenExpiryIso } from './share-token';

/** Replica el formato real de share-service: base64url("<shareId>.<expiresAtMs>.<nonce>") + "." + sig. */
function makeToken(shareId: string, expiresAtMs: number, nonce = 'nonce', sig = 'deadbeef'): string {
  const body = `${shareId}.${expiresAtMs}.${nonce}`;
  const bodyB64 = Buffer.from(body, 'utf8').toString('base64url');
  return `${bodyB64}.${sig}`;
}

describe('parseShareToken', () => {
  it('extrae shareId y expiresAtMs del cuerpo', () => {
    const exp = Date.UTC(2026, 4, 29, 12, 0, 0);
    const info = parseShareToken(makeToken('share-1', exp));
    expect(info.shareId).toBe('share-1');
    expect(info.expiresAtMs).toBe(exp);
  });

  it('shareTokenExpiryIso devuelve ISO-8601', () => {
    const exp = Date.UTC(2026, 4, 29, 12, 0, 0);
    expect(shareTokenExpiryIso(makeToken('share-1', exp))).toBe('2026-05-29T12:00:00.000Z');
  });

  it('lanza ValidationError si el token no tiene firma', () => {
    expect(() => parseShareToken('soloalgo')).toThrow(ValidationError);
  });

  it('lanza ValidationError si el cuerpo no tiene 3 partes', () => {
    const bad = `${Buffer.from('share-1.123', 'utf8').toString('base64url')}.sig`;
    expect(() => parseShareToken(bad)).toThrow(ValidationError);
  });
});
