/**
 * Ola 2B — Reglas de dominio de los VIAJES PROGRAMADOS (lógica pura, sin I/O).
 *
 * BR (viajes programados):
 *  - Un viaje programado lleva `scheduledFor` futuro dentro de una ventana válida:
 *      mínimo  MIN_LEAD_MS  (≥15 min): da margen para activar y conseguir conductor.
 *      máximo  MAX_HORIZON_MS (≤7 días): cota superior de planificación.
 *  - El SCHEDULER activa el viaje (SCHEDULED → REQUESTED) cuando faltan ≤ ACTIVATION_LEAD_MS
 *    (default 10 min) para `scheduledFor`. Activar antes da tiempo al matching antes de la hora.
 *  - Cancelar un viaje programado ANTES de activarse no tiene penalidad (BR-T03 no aplica: aún no
 *    hubo asignación ni conductor en camino). La penalidad de cancelación es para viajes ya en curso
 *    de dispatch; un SCHEDULED es solo una reserva.
 */
import { ValidationError } from '@veo/utils';

/** Antelación mínima de un viaje programado: 15 minutos. */
export const MIN_LEAD_MS = 15 * 60 * 1000;
/** Horizonte máximo de un viaje programado: 7 días. */
export const MAX_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
/** Lead time de activación: el scheduler activa el viaje 10 min antes de la hora. */
export const ACTIVATION_LEAD_MS = 10 * 60 * 1000;

/**
 * Valida que `scheduledFor` caiga en la ventana permitida respecto a `now`.
 * Lanza ValidationError si está en el pasado, demasiado pronto o demasiado lejos.
 * Devuelve la fecha parseada.
 */
export function assertScheduleWindow(scheduledFor: Date, now: Date): Date {
  const delta = scheduledFor.getTime() - now.getTime();
  if (Number.isNaN(delta)) {
    throw new ValidationError('scheduledFor no es una fecha válida', { scheduledFor });
  }
  if (delta < MIN_LEAD_MS) {
    throw new ValidationError(
      'El viaje programado debe ser con al menos 15 minutos de antelación',
      {
        scheduledFor: scheduledFor.toISOString(),
        minLeadMinutes: MIN_LEAD_MS / 60000,
      },
    );
  }
  if (delta > MAX_HORIZON_MS) {
    throw new ValidationError('El viaje programado no puede ser a más de 7 días', {
      scheduledFor: scheduledFor.toISOString(),
      maxHorizonDays: MAX_HORIZON_MS / (24 * 60 * 60 * 1000),
    });
  }
  return scheduledFor;
}

/** ¿El viaje programado ya debe activarse? (faltan ≤ lead time para la hora). */
export function isDueForActivation(
  scheduledFor: Date,
  now: Date,
  leadMs = ACTIVATION_LEAD_MS,
): boolean {
  return scheduledFor.getTime() - now.getTime() <= leadMs;
}
