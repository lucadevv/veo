/**
 * Generación de identificadores. VEO usa UUIDv7 (ordenable por tiempo) para todas las PKs y dedupKeys.
 * Implementación pura sin dependencias externas (RFC 9562 §5.7).
 */
import { randomBytes } from 'node:crypto';

const UUID_V7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * UUIDv7: 48 bits de timestamp en ms + version + variante + 74 bits aleatorios.
 * Ordenable lexicográficamente por tiempo de creación → ideal para índices Postgres.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);

  // 48 bits de timestamp (ms desde epoch) en los primeros 6 bytes.
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  // Versión 7 en el nibble alto del byte 6.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  // Variante RFC 4122 (10xx) en el byte 8.
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

/** Clave de idempotencia para mutaciones con efectos (pagos, pánico). Es un UUIDv7. */
export function newDedupKey(): string {
  return uuidv7();
}

export function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

export function isUuidV7(value: string): boolean {
  return UUID_V7_REGEX.test(value);
}
