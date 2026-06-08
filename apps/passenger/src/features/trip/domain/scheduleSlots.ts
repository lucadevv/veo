import { MAX_SCHEDULE_HORIZON_MS, MIN_SCHEDULE_LEAD_MS } from './scheduling';

/**
 * Generadores PUROS de opciones para el selector de fecha/hora de un viaje programado (Ola 2B).
 * No hay date-picker en el ui-kit; armamos un selector propio con chips de DÍA + chips de HORA.
 * Todo determinista (acepta `now` inyectable) para testear sin tocar el reloj real.
 */

/** Un día seleccionable en el picker (epoch de medianoche local + etiqueta corta). */
export interface DayOption {
  /** Epoch (ms) de las 00:00 locales de ese día. */
  startOfDay: number;
  /** Día del mes (1-31). */
  dayOfMonth: number;
  /** Índice de día de la semana (0=domingo). */
  weekday: number;
}

/** Granularidad de los horarios ofrecidos (cada 15 minutos). */
export const TIME_SLOT_STEP_MIN = 15;

/** Devuelve el epoch de las 00:00 locales del día de `date`. */
function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Días seleccionables: desde hoy hasta el último día dentro de la ventana de 7 días. Se incluye hoy
 * solo si todavía cabe un horario válido (now+15min) antes de medianoche; el filtrado fino de horas
 * lo hace `timeSlotsForDay`.
 */
export function scheduleDayOptions(now: Date = new Date()): DayOption[] {
  const days: DayOption[] = [];
  const todayStart = startOfLocalDay(now);
  const horizon = now.getTime() + MAX_SCHEDULE_HORIZON_MS;
  for (let offset = 0; offset < 8; offset += 1) {
    const dayStart = todayStart + offset * 24 * 60 * 60 * 1000;
    // Sin horarios válidos en ese día (todo cae fuera de la ventana) ⇒ no se ofrece.
    if (timeSlotsForDay(dayStart, now).length === 0) {
      continue;
    }
    if (dayStart > horizon) {
      break;
    }
    const date = new Date(dayStart);
    days.push({
      startOfDay: dayStart,
      dayOfMonth: date.getDate(),
      weekday: date.getDay(),
    });
  }
  return days;
}

/**
 * Horarios válidos (epoch ms) para el día cuyo inicio es `startOfDay`, en pasos de
 * `TIME_SLOT_STEP_MIN`. Solo se incluyen los que caen en la ventana [now+15min, now+7días].
 */
export function timeSlotsForDay(startOfDay: number, now: Date = new Date()): number[] {
  const slots: number[] = [];
  const earliest = now.getTime() + MIN_SCHEDULE_LEAD_MS;
  const latest = now.getTime() + MAX_SCHEDULE_HORIZON_MS;
  const stepMs = TIME_SLOT_STEP_MIN * 60 * 1000;
  const dayEnd = startOfDay + 24 * 60 * 60 * 1000;
  for (let ts = startOfDay; ts < dayEnd; ts += stepMs) {
    if (ts >= earliest && ts <= latest) {
      slots.push(ts);
    }
  }
  return slots;
}
