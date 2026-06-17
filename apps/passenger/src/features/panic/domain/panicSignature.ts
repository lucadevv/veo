import type {GeoPoint} from '@veo/api-client';

/**
 * Contrato de firma del pánico (BR-S04), ESPEJO EXACTO del backend (`panic-service`).
 *
 * Mensaje canónico (`panic.trigger:v1`), campos separados por `\n`:
 *   panic.trigger:v1
 *   <tripId>
 *   <dedupKey>
 *   <lat con 6 decimales fijos>   // ej. -12.046400
 *   <lon con 6 decimales fijos>   // ej. -77.042800
 *
 * Se fijan 6 decimales (~0.11 m) para evitar divergencias de coma flotante entre cliente y servidor.
 * Cualquier cambio aquí DEBE coordinarse con `panic-service/src/panic/panic.hmac.ts`.
 */
export const PANIC_SIGNATURE_VERSION = 'panic.trigger:v1';

/** Construye el mensaje canónico determinista a firmar con HMAC-SHA256. */
export function buildPanicSignatureMessage(input: {
  tripId: string;
  dedupKey: string;
  geo: GeoPoint;
}): string {
  return [
    PANIC_SIGNATURE_VERSION,
    input.tripId,
    input.dedupKey,
    input.geo.lat.toFixed(6),
    input.geo.lon.toFixed(6),
  ].join('\n');
}
