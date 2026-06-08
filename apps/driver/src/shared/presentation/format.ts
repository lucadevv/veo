// Submódulo puro: evita el barrel `@veo/utils` que arrastra `ids`/`crypto` (node:crypto),
// inexistente en Hermes/React Native.
import {formatPEN as formatPENRaw} from '@veo/utils/money';

/**
 * Formatea céntimos PEN a soles ("S/ 15.00") reutilizando `@veo/utils` (céntimos → soles).
 *
 * Defensa: si llega `undefined`/`null`/`NaN` (campo opcional ausente o dato fuera de contrato), el
 * helper crudo produciría "S/ NaN". Aquí degradamos a 0 céntimos → "S/ 0.00", nunca a un valor roto.
 */
export function formatPEN(cents: number | null | undefined): string {
  return formatPENRaw(typeof cents === 'number' && Number.isFinite(cents) ? cents : 0);
}

/** Fecha corta es-PE (ej. "29 may 2026") a partir de un ISO-8601; vacío si la fecha es inválida. */
export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleDateString('es-PE', {day: '2-digit', month: 'short', year: 'numeric'});
}

/** Formatea segundos a "m min" redondeando hacia arriba (ETAs/duración). */
export function secondsToMinutes(seconds: number): number {
  return Math.max(0, Math.ceil(seconds / 60));
}

/** Formatea metros a kilómetros con un decimal. */
export function metersToKm(meters: number): string {
  return (meters / 1000).toFixed(1);
}
