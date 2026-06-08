import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { liveKitEnabled, mintViewerToken, type LiveKitConfig } from './livekit-token';

const cfg: LiveKitConfig = {
  url: 'ws://localhost:7880',
  apiKey: 'devkey',
  apiSecret: 'devsecret_change_in_production',
  ttlSec: 3600,
};

function decodeSegment<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
}

describe('liveKitEnabled', () => {
  it('está deshabilitado sin credenciales', () => {
    expect(liveKitEnabled({ ...cfg, apiKey: '', apiSecret: '' })).toBe(false);
    expect(liveKitEnabled({ ...cfg, apiSecret: '' })).toBe(false);
  });

  it('está habilitado con apiKey y apiSecret', () => {
    expect(liveKitEnabled(cfg)).toBe(true);
  });
});

describe('mintViewerToken', () => {
  it('emite un JWT HS256 con grant de solo suscripción y firma válida', () => {
    const { token, identity, expiresAt } = mintViewerToken(cfg, {
      room: 'trip:abc',
      identityPrefix: 'family-s1',
    });

    const [headerB64, payloadB64, signature] = token.split('.');
    expect(headerB64 && payloadB64 && signature).toBeTruthy();

    const header = decodeSegment<{ alg: string; typ: string }>(headerB64!);
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });

    const payload = decodeSegment<{
      iss: string;
      sub: string;
      nbf: number;
      exp: number;
      video: Record<string, unknown>;
    }>(payloadB64!);
    expect(payload.iss).toBe('devkey');
    expect(payload.sub).toBe(identity);
    expect(identity.startsWith('family-s1-')).toBe(true);
    expect(payload.exp).toBeGreaterThan(payload.nbf);
    expect(payload.video).toEqual({
      room: 'trip:abc',
      roomJoin: true,
      canSubscribe: true,
      canPublish: false,
      canPublishData: false,
    });

    const expectedSig = createHmac('sha256', cfg.apiSecret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');
    expect(signature).toBe(expectedSig);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('genera identidades únicas por llamada', () => {
    const a = mintViewerToken(cfg, { room: 'trip:x', identityPrefix: 'family-s1' });
    const b = mintViewerToken(cfg, { room: 'trip:x', identityPrefix: 'family-s1' });
    expect(a.identity).not.toBe(b.identity);
  });
});
