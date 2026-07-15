import type { TFunction } from 'i18next';
import { formatShortDate } from '../../../shared/presentation/format';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Tiempo relativo es-PE para la fila del feed: "Ahora" / "hace N min" / "hace N h" / "Ayer" y, más
 * atrás, la fecha corta ("29 may 2026"). Usa i18n (claves `notifications.time.*`) con plural i18next.
 * Devuelve '' si la fecha es inválida (el consumidor oculta el label). `now` es inyectable para tests.
 */
export function relativeTime(iso: string, t: TFunction, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return '';
  }
  const diff = now - then;
  if (diff < MINUTE) {
    return t('notifications.time.now');
  }
  if (diff < HOUR) {
    return t('notifications.time.minutes', { count: Math.floor(diff / MINUTE) });
  }
  if (diff < DAY) {
    return t('notifications.time.hours', { count: Math.floor(diff / HOUR) });
  }
  if (diff < 2 * DAY) {
    return t('notifications.time.yesterday');
  }
  return formatShortDate(iso);
}
