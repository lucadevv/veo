/**
 * Generadores de UUID puros (sin `node:crypto`, que NO existe en Hermes).
 *
 * Se usan para `dedupKey`/idempotencia de mutaciones (pagos, pánico). No son material
 * criptográfico de seguridad (la firma del pánico la produce `PanicSigner`).
 */

/** Byte aleatorio 0..255. `Math.random` basta para idempotencia (no es secreto). */
function randomByte(): number {
  return (Math.random() * 256) | 0;
}

/** UUID v4. Aceptado por `@IsUUID()` del backend (versiones 1-5). */
export function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/**
 * UUID v7 (timestamp de 48 bits en ms + versión + variante + bits aleatorios).
 *
 * REQUERIDO para el `dedupKey` del pánico: el panic-service valida `isUuidV7` y rechaza otras
 * versiones (incluida v4). Ordenable por tiempo de creación, ideal para idempotencia.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Array<number>(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = randomByte();
  }

  // 48 bits de timestamp (ms desde epoch) en los primeros 6 bytes (big-endian).
  let ts = now;
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }

  // Versión 7 en el nibble alto del byte 6.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // Variante RFC 4122 (10xx) en el byte 8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}
