/**
 * Reglas puras de incentivos (Ola 2C). Sin I/O: deciden vigencia, franja horaria activa y estado de
 * cumplimiento a partir de los campos del catálogo y el progreso. Testeables en aislamiento.
 */
import type { Incentive, IncentiveProgress } from '../generated/prisma';

/** ¿El incentivo está vigente en `now` (activo y dentro de [startsAt, endsAt])? */
export function isActiveAt(incentive: Pick<Incentive, 'active' | 'startsAt' | 'endsAt'>, now: Date): boolean {
  if (!incentive.active) return false;
  if (incentive.startsAt && now < incentive.startsAt) return false;
  if (incentive.endsAt && now > incentive.endsAt) return false;
  return true;
}

/**
 * ¿La hora local `now` cae dentro de la franja pico [peakStartMinute, peakEndMinute)?
 * Soporta franjas que cruzan medianoche (start > end). Si faltan los límites, devuelve false.
 */
export function isWithinPeak(
  incentive: Pick<Incentive, 'peakStartMinute' | 'peakEndMinute'>,
  now: Date,
): boolean {
  const { peakStartMinute: start, peakEndMinute: end } = incentive;
  if (start == null || end == null) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  if (start <= end) return minute >= start && minute < end;
  // Cruza medianoche: p.ej. 22:00→02:00.
  return minute >= start || minute < end;
}

/**
 * ¿Una META_VIAJES está cumplida dado el progreso? (tripsCompleted ≥ targetTrips, target > 0).
 * Para HORA_PICO el "completado" es que la franja esté activa (no depende del progreso).
 */
export function isMetaCompleted(
  incentive: Pick<Incentive, 'type' | 'targetTrips'>,
  tripsCompleted: number,
): boolean {
  return incentive.type === 'META_VIAJES' && incentive.targetTrips > 0 && tripsCompleted >= incentive.targetTrips;
}

/** Estado "completed" expuesto a la app: meta cumplida (META_VIAJES) o franja activa (HORA_PICO). */
export function computeCompleted(
  incentive: Pick<Incentive, 'type' | 'targetTrips' | 'peakStartMinute' | 'peakEndMinute'>,
  progress: Pick<IncentiveProgress, 'tripsCompleted'> | null,
  now: Date,
): boolean {
  if (incentive.type === 'HORA_PICO') return isWithinPeak(incentive, now);
  return isMetaCompleted(incentive, progress?.tripsCompleted ?? 0);
}
