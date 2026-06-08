/**
 * Entidades de dominio de Modo Niño.
 *
 * Regla del repo: el código NUNCA se muestra en la app del conductor; el backend valida
 * un hash. En el pasajero, el código (4-6 dígitos) se adjunta al crear el viaje
 * (`CreateTripRequest.childCode`); no hay endpoint standalone aún.
 */

/** Patrón del código de modo niño (espeja el regex del contrato `createTripRequest`). */
export const CHILD_CODE_PATTERN = /^\d{4,6}$/;

/** Valida el formato del código de modo niño (dominio puro, sin red). */
export function isValidChildCode(code: string): boolean {
  return CHILD_CODE_PATTERN.test(code);
}

/** Configuración de un viaje con modo niño activado. */
export interface ChildModeConfig {
  enabled: boolean;
  /** Código de 4-6 dígitos; sólo presente cuando `enabled`. */
  code?: string;
}
