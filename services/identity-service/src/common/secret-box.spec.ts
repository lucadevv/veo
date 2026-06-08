import { describe, it, expect } from 'vitest';
import { seal, open } from './secret-box';

describe('secret-box (AES-256-GCM)', () => {
  it('cifra y descifra (round-trip)', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const sealed = seal(secret, 'enc-key');
    expect(sealed).not.toContain(secret);
    expect(open(sealed, 'enc-key')).toBe(secret);
  });

  it('falla al abrir con clave incorrecta', () => {
    const sealed = seal('secreto-totp', 'clave-1');
    expect(() => open(sealed, 'clave-2')).toThrow();
  });

  it('falla con datos manipulados (autenticación GCM)', () => {
    const sealed = seal('secreto', 'k');
    const tampered = `${sealed.slice(0, -2)}xy`;
    expect(() => open(tampered, 'k')).toThrow();
  });
});
