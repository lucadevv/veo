import {uuidv7} from '../src/shared/utils/uuid';

/**
 * El panic-service exige `dedupKey` en formato UUIDv7 (rechaza v4). Estas pruebas garantizan que el
 * generador del cliente cumple versión, variante, formato y orden temporal.
 */
describe('uuidv7', () => {
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('genera un UUID con formato canónico', () => {
    expect(uuidv7()).toMatch(UUID_RE);
  });

  it('fija la versión 7 (primer nibble del 3.er grupo)', () => {
    const value = uuidv7();
    expect(value[14]).toBe('7');
  });

  it('fija la variante RFC 4122 (10xx) en el 4.º grupo', () => {
    const variant = uuidv7()[19]!;
    expect(['8', '9', 'a', 'b']).toContain(variant);
  });

  it('codifica el timestamp de 48 bits en el prefijo (ordenable por tiempo)', () => {
    const now = 0x0123456789ab;
    const value = uuidv7(now);
    // Primeros 12 hex = 48 bits de timestamp big-endian.
    const prefix = value.replace(/-/g, '').slice(0, 12);
    expect(prefix).toBe('0123456789ab');
  });

  it('un timestamp mayor produce un prefijo lexicográficamente mayor', () => {
    const a = uuidv7(1000).replace(/-/g, '').slice(0, 12);
    const b = uuidv7(2000).replace(/-/g, '').slice(0, 12);
    expect(a < b).toBe(true);
  });
});
