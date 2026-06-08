/**
 * Ventanas temporales (UTC) para el desglose de ganancias del conductor.
 * Puras y deterministas → testeables. La semana es [lunes 00:00, lunes+7 00:00) para alinear con
 * la convención de liquidación semanal de payment-service (payouts).
 */

export interface TimeWindow {
  start: Date;
  end: Date;
}

/** Día natural UTC que contiene a `now`: [00:00 hoy, 00:00 mañana). */
export function dayWindow(now: Date): TimeWindow {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 1);
  return { start, end };
}

/** Semana UTC en curso que contiene a `now`: [lunes 00:00, lunes+7 00:00). */
export function weekWindow(now: Date): TimeWindow {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = day.getUTCDay(); // 0=domingo..6=sábado
  const daysSinceMonday = (dow + 6) % 7;
  const start = new Date(day);
  start.setUTCDate(day.getUTCDate() - daysSinceMonday);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { start, end };
}
