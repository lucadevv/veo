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

const TIME = new Intl.DateTimeFormat('es-PE', { hour: '2-digit', minute: '2-digit' });

const NUMBER = new Intl.NumberFormat('es-PE');

/** 1500 (céntimos) → "S/ 15.00". */
export function money(cents: number): string {
  return formatPEN(cents);
}

/** ISO-8601 → "29/05/2026 00:49". Devuelve "—" si la fecha no es válida. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : DATE_TIME.format(d);
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
