// Submódulo puro: evita el barrel `@veo/utils` que arrastra `ids`/`crypto` (node:crypto),
// inexistente en Hermes/React Native.
import { formatPEN as formatPENRaw } from '@veo/utils/money';

/**
 * Formatea céntimos PEN a soles ("S/ 15.00") reutilizando `@veo/utils` (céntimos → soles).
 *
 * Defensa: si llega `undefined`/`null`/`NaN` (campo opcional ausente o dato fuera de contrato), el
 * helper crudo produciría "S/ NaN". Aquí degradamos a 0 céntimos → "S/ 0.00", nunca a un valor roto.
 */
export function formatPEN(cents: number | null | undefined): string {
  return formatPENRaw(typeof cents === 'number' && Number.isFinite(cents) ? cents : 0);
}

/** Patrón de una fecha canónica `YYYY-MM-DD` (el formato de los contratos y del `DateField`). */
const ISO_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Fecha corta es-PE (ej. "29 may 2026") a partir de un ISO-8601; vacío si la fecha es inválida.
 *
 * OJO timezone: `new Date('YYYY-MM-DD')` se interpreta a MEDIANOCHE UTC y, al localizar en un huso
 * negativo (Lima = UTC-5), RETROCEDE un día ("1998-12-07" → "06 dic"). Por eso, para un date-only
 * canónico construimos el `Date` con los componentes en HORA LOCAL (mediodía, lejos de cualquier salto
 * de DST), de modo que el día mostrado sea EXACTAMENTE el del string. Para otros formatos ISO (con hora
 * y huso explícitos) se respeta el `Date` nativo.
 */
export function formatShortDate(iso: string): string {
  const dateOnly = ISO_DATE_ONLY.exec(iso.trim());
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12, 0, 0, 0)
    : new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Formatea segundos a "m min" redondeando hacia arriba (ETAs/duración). */
export function secondsToMinutes(seconds: number): number {
  return Math.max(0, Math.ceil(seconds / 60));
}

/** Formatea metros a kilómetros con un decimal. */
export function metersToKm(meters: number): string {
  return (meters / 1000).toFixed(1);
}

/**
 * Presenta un nombre propio en Title Case. El OCR del onboarding suele venir en MAYÚSCULAS
 * ("CARRANZA LUIS IVAN" grita); esto lo suaviza a "Carranza Luis Ivan". Fuente ÚNICA para el saludo del
 * Inicio y la identidad de la Cuenta (coherencia — antes cada pantalla lo resolvía distinto). `null`/vacío
 * → `null` (el consumidor decide el fallback: rol genérico en el saludo, teléfono en la identidad).
 */
export function formatPersonName(fullName: string | null | undefined): string | null {
  const name = fullName?.trim();
  if (!name) {
    return null;
  }
  return name
    .toLowerCase()
    .split(/\s+/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}
