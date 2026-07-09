/**
 * Etiquetas cortas de fecha es-PE para el carpooling ("Vie 4 jul", como el pen), sin Intl
 * (Hermes/Jest-safe, mismo criterio que `shared/utils/format.ts`).
 */

/** Día de semana corto es-PE (0=domingo). */
const WEEKDAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'] as const;

/** Mes corto es-PE (0=enero), en minúscula como en el pen ("4 jul"). */
const MONTHS = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'set',
  'oct',
  'nov',
  'dic',
] as const;

/** "Vie 4 jul" de una fecha local. */
export function formatDayShort(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/**
 * "Vie 4 jul" de un día calendario YYYY-MM-DD (el formato que viaja como `fecha` de búsqueda).
 * Se parsea A MANO como fecha LOCAL: `new Date('YYYY-MM-DD')` interpreta UTC y correría el día
 * en Lima (UTC-5).
 */
export function formatIsoDayShort(isoDay: string): string {
  const [year, month, day] = isoDay.split('-').map(Number);
  if (!year || !month || !day) {
    return isoDay;
  }
  return formatDayShort(new Date(year, month - 1, day));
}

/** "Vie 4 jul · 08:30" de un ISO-8601 con hora (fechaHoraSalida del viaje publicado). */
export function formatDayTimeShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${formatDayShort(date)} · ${hours}:${minutes}`;
}
