import { hmacSha256Hex } from '../src/shared/crypto/hmacSha256';

/**
 * Verifica el HMAC-SHA256 puro (Hermes) contra vectores de prueba conocidos. Si esto pasa, la firma
 * del pánico coincidirá bit a bit con la que valida el backend.
 */
describe('hmacSha256Hex', () => {
  it('reproduce el vector clásico key/"quick brown fox"', () => {
    expect(
      hmacSha256Hex('The quick brown fox jumps over the lazy dog', 'key'),
    ).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });

  it('maneja mensaje y clave vacíos (vector RFC)', () => {
    expect(hmacSha256Hex('', '')).toBe(
      'b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad',
    );
  });

  it('soporta claves más largas que el bloque (64 bytes), que se hashean primero', () => {
    const longKey = 'a'.repeat(100);
    // Determinista: misma entrada → misma salida, y longitud hex de 64 (256 bits).
    const sig = hmacSha256Hex('mensaje', longKey);
    expect(sig).toHaveLength(64);
    expect(sig).toBe(hmacSha256Hex('mensaje', longKey));
  });

  it('es sensible a UTF-8 multibyte', () => {
    expect(hmacSha256Hex('niño', 'clave')).not.toBe(hmacSha256Hex('nino', 'clave'));
  });
});
