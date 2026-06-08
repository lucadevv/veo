/**
 * Firma del request de pánico (BR-S04), replicando `buildPanicSignatureMessage` de panic-service.
 * El cliente (app) firma un mensaje canónico determinista con el secreto compartido obtenido vía
 * `GET /auth/panic-key`; panic-service lo verifica con verifyHmac (tiempo constante).
 *
 * Mensaje canónico (v1), campos separados por '\n':
 *   panic.trigger:v1
 *   <tripId>
 *   <dedupKey>
 *   <lat con 6 decimales fijos>
 *   <lon con 6 decimales fijos>
 */
import { createHmac, randomFillSync } from 'node:crypto';

export const PANIC_SIGNATURE_VERSION = 'panic.trigger:v1';

/**
 * Genera un UUIDv7 (timestamp ms en los 48 bits altos + aleatorio). panic-service exige que el
 * dedupKey sea UUIDv7 (no v4). Implementación mínima compatible con `@veo/utils.uuidv7`.
 */
export function uuidv7(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);
  // 48 bits de timestamp (big-endian) en los bytes 0..5
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  // versión 7 en el nibble alto del byte 6, variante RFC4122 en el byte 8
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface PanicSignatureInput {
  tripId: string;
  dedupKey: string;
  lat: number;
  lon: number;
}

export function buildPanicSignatureMessage(input: PanicSignatureInput): string {
  return [
    PANIC_SIGNATURE_VERSION,
    input.tripId,
    input.dedupKey,
    input.lat.toFixed(6),
    input.lon.toFixed(6),
  ].join('\n');
}

export function signPanic(secret: string, input: PanicSignatureInput): string {
  return createHmac('sha256', secret).update(buildPanicSignatureMessage(input)).digest('hex');
}
