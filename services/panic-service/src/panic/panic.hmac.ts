/**
 * Firma HMAC del request de pánico (BR-S04).
 * El cliente firma un mensaje canónico determinista con un secreto compartido; el servicio
 * lo verifica en tiempo constante (@veo/utils verifyHmac) y rechaza firmas inválidas.
 *
 * Mensaje canónico (v1), campos separados por '\n':
 *   panic.trigger:v1
 *   <tripId>
 *   <dedupKey>
 *   <lat con 6 decimales fijos>
 *   <lon con 6 decimales fijos>
 *
 * Se fijan 6 decimales (~0.11 m) para evitar divergencias por el formato de coma flotante
 * entre cliente (Flutter/JS) y servidor. El contrato está documentado en el README.
 */
export const PANIC_HMAC_SECRET = Symbol('PANIC_HMAC_SECRET');

export const PANIC_SIGNATURE_VERSION = 'panic.trigger:v1';

export interface PanicSignaturePayload {
  tripId: string;
  dedupKey: string;
  lat: number;
  lon: number;
}

export function buildPanicSignatureMessage(input: PanicSignaturePayload): string {
  return [
    PANIC_SIGNATURE_VERSION,
    input.tripId,
    input.dedupKey,
    input.lat.toFixed(6),
    input.lon.toFixed(6),
  ].join('\n');
}
