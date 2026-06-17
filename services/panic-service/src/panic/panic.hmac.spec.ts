import { describe, it, expect } from 'vitest';
import { signHmac, verifyHmac, uuidv7 } from '@veo/utils';
import { buildPanicSignatureMessage, PANIC_SIGNATURE_VERSION } from './panic.hmac';

const SECRET = 'unit-test-panic-secret';

describe('panic HMAC · firma del request de pánico (BR-S04)', () => {
  it('construye un mensaje canónico determinista (versión + campos + 6 decimales)', () => {
    const tripId = '00000000-0000-7000-8000-000000000001';
    const dedupKey = '00000000-0000-7000-8000-000000000002';
    const msg = buildPanicSignatureMessage({ tripId, dedupKey, lat: -12.0464, lon: -77.0428 });
    expect(msg).toBe(
      [PANIC_SIGNATURE_VERSION, tripId, dedupKey, '-12.046400', '-77.042800'].join('\n'),
    );
  });

  it('normaliza la precisión de lat/lon a 6 decimales (evita divergencias de coma flotante)', () => {
    const base = { tripId: 't', dedupKey: 'd' };
    const a = buildPanicSignatureMessage({ ...base, lat: -12.04640001, lon: -77.0428 });
    const b = buildPanicSignatureMessage({ ...base, lat: -12.0464, lon: -77.0428 });
    expect(a).toBe(b);
  });

  it('una firma válida verifica y una manipulada se rechaza', () => {
    const dedupKey = uuidv7();
    const message = buildPanicSignatureMessage({
      tripId: uuidv7(),
      dedupKey,
      lat: -12.05,
      lon: -77.04,
    });
    const sig = signHmac(message, SECRET);
    expect(verifyHmac(message, SECRET, sig)).toBe(true);
    // Manipula el primer carácter hex garantizando que cambie.
    const tampered = (sig.startsWith('a') ? 'b' : 'a') + sig.slice(1);
    expect(verifyHmac(message, SECRET, tampered)).toBe(false);
    expect(verifyHmac(message + 'x', SECRET, sig)).toBe(false);
    expect(verifyHmac(message, 'otro-secreto', sig)).toBe(false);
  });
});
