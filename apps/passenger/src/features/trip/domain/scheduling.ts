/**
 * Reglas de dominio de los VIAJES PROGRAMADOS (Ola 2B). Puras y deterministas: validan la ventana
 * de programación SIN tocar la red, para que la UI deshabilite el CTA y muestre un mensaje claro
 * antes de llamar a `createTrip`. El backend revalida la misma ventana [≥15min, ≤7días].
 */

/** Antelación mínima de un viaje programado (15 minutos en milisegundos). */
export const MIN_SCHEDULE_LEAD_MS = 15 * 60 * 1000;

/** Horizonte máximo de programación (7 días en milisegundos). */
export const MAX_SCHEDULE_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

/** Resultado de validar una fecha/hora de programación contra la ventana operativa. */
export type ScheduleValidation =
  | { valid: true }
  | { valid: false; reason: 'TOO_SOON' | 'TOO_FAR' | 'INVALID' };

/**
 * Valida que `scheduledAt` caiga dentro de la ventana [now+15min, now+7días]. `now` es inyectable
 * para tests deterministas (por defecto, el reloj real). No interpreta zonas horarias: trabaja en
 * epoch absoluto (la UI arma la fecha local; el backend recibe el ISO con offset).
 */
export function validateScheduledFor(
  scheduledAt: Date,
  now: Date = new Date(),
): ScheduleValidation {
  const target = scheduledAt.getTime();
  if (Number.isNaN(target)) {
    return { valid: false, reason: 'INVALID' };
  }
  const lead = target - now.getTime();
  if (lead < MIN_SCHEDULE_LEAD_MS) {
    return { valid: false, reason: 'TOO_SOON' };
  }
  if (lead > MAX_SCHEDULE_HORIZON_MS) {
    return { valid: false, reason: 'TOO_FAR' };
  }
  return { valid: true };
}
