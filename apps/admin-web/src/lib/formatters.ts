/**
 * Formateadores de presentación. El dinero SIEMPRE llega en céntimos PEN (enteros).
 * Reutiliza formatPEN de @veo/utils para mantener una sola fuente de verdad.
 */
import { formatPEN } from '@veo/utils/money';

const DATE_TIME = new Intl.DateTimeFormat('es-PE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Formato de fecha de CALENDARIO (sin hora). Se ancla a `UTC` a propósito: las fechas date-only
 * (`YYYY-MM-DD`, p. ej. un vencimiento) se parsean como medianoche UTC, así que renderizarlas en UTC
 * devuelve el MISMO día de calendario sin el desfase de la TZ local (Perú UTC-5 restaría un día).
 */
const DATE_ONLY = new Intl.DateTimeFormat('es-PE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

const TIME = new Intl.DateTimeFormat('es-PE', { hour: '2-digit', minute: '2-digit' });

const NUMBER = new Intl.NumberFormat('es-PE');

/**
 * ¿El string es una fecha date-only `YYYY-MM-DD` (sin componente horario)? Estas representan un día de
 * CALENDARIO (vencimientos, fechas de emisión sin hora), NO un instante: deben mostrarse sin hora y sin
 * desplazamiento de TZ. `new Date('2027-06-13')` las interpreta como medianoche UTC, así que basta con
 * formatearlas en UTC para preservar el día. Un timestamp real (con `T`/hora) NO matchea → cae al
 * comportamiento normal (fecha + hora local).
 */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isDateOnly(value: string): boolean {
  return DATE_ONLY_PATTERN.test(value.trim());
}

/** 1500 (céntimos) → "S/ 15.00". */
export function money(cents: number): string {
  return formatPEN(cents);
}

/**
 * ISO-8601 → "29/05/2026 00:49". Devuelve "—" si la fecha no es válida.
 *
 * Las fechas date-only (`YYYY-MM-DD`, p. ej. un vencimiento sin hora) se tratan como día de CALENDARIO:
 * se formatean en UTC y SIN hora, para no inventar "00:00" ni restar un día por la TZ local (Perú UTC-5).
 * Un timestamp real (con hora) conserva el formato fecha + hora en la zona local.
 */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return isDateOnly(iso) ? DATE_ONLY.format(d) : DATE_TIME.format(d);
}

/**
 * Fecha de CALENDARIO sin hora → "13/06/2027". Pensado para VENCIMIENTOS y fechas date-only del dominio
 * (licencia, SOAT, tarjeta, nacimiento). SIEMPRE se ancla a UTC a propósito: estas fechas representan un
 * día de calendario y se guardan como medianoche UTC — tanto si llegan como `YYYY-MM-DD` (`new Date` las
 * parsea a medianoche UTC) como si llegan como timestamp `...T00:00:00.000Z` (columna `@db.Timestamptz`).
 * Formatear en UTC devuelve el MISMO día sin el desfase de la TZ local (Perú UTC-5 restaría un día → mostraría
 * el 12 en vez del 13). NO usar para timestamps con hora significativa (alta/emisión): para eso, `dateTime()`.
 * Devuelve "—" si la fecha no es válida.
 */
export function date(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return DATE_ONLY.format(d);
}

/** ISO-8601 → "00:49". */
export function time(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : TIME.format(d);
}

/** Entero/decimal con separadores locales. */
export function number(value: number): string {
  return NUMBER.format(value);
}

/** Segundos → "12 min" / "1 h 05 min" para ETAs. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  const mins = Math.floor(total / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return `${hours} h ${rest.toString().padStart(2, '0')} min`;
}

/** Diferencia relativa desde ahora en español ("hace 3 min", "en 2 h"). */
export function relativeFromNow(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = d.getTime() - Date.now();
  const rtf = new Intl.RelativeTimeFormat('es-PE', { numeric: 'auto' });
  const diffMin = Math.round(diffMs / 60000);
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute');
  const diffHour = Math.round(diffMin / 60);
  if (Math.abs(diffHour) < 24) return rtf.format(diffHour, 'hour');
  return rtf.format(Math.round(diffHour / 24), 'day');
}
