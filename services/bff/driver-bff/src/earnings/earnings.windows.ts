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

/** Mes UTC en curso que contiene a `now`: [día 1 00:00, día 1 del mes siguiente 00:00). */
export function monthWindow(now: Date): TimeWindow {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  // Date.UTC normaliza mes 12 → enero del año siguiente, así que el cambio dic→ene sale solo.
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * Las 7 ventanas de día natural de la SEMANA en curso (lunes→domingo), en orden y contiguas.
 * Cubren exactamente `weekWindow(now)`: la primera arranca en el lunes de la semana y cada
 * elemento es un día [00:00, +24h). Útil para la serie diaria del bar chart de ganancias.
 */
export function weekDailyWindows(now: Date): TimeWindow[] {
  const { start } = weekWindow(now);
  const windows: TimeWindow[] = [];
  for (let i = 0; i < 7; i += 1) {
    const dayStart = new Date(start);
    dayStart.setUTCDate(start.getUTCDate() + i);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayStart.getUTCDate() + 1);
    windows.push({ start: dayStart, end: dayEnd });
  }
  return windows;
}
