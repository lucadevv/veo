/**
 * Ventanas temporales del desglose de ganancias del conductor, ancladas al día LOCAL de negocio:
 * America/Lima (UTC-5 FIJO, Perú no aplica horario de verano — misma convención que los analytics
 * de payment-service y trip-service). Con ventanas UTC el "hoy" del conductor se reseteaba a las
 * 19:00 de Lima y los viajes de la noche caían en "mañana". Puras y deterministas → testeables.
 * La semana es [lunes 00:00, lunes+7 00:00) Lima; OJO: la liquidación semanal de payouts
 * (payouts.service `previousWeek`) corre sobre semanas UTC — los bordes difieren 5h, el período
 * autoritativo de un payout es el suyo propio, estas ventanas son solo de VISUALIZACIÓN.
 */

export interface TimeWindow {
  start: Date;
  end: Date;
}

/** Offset fijo de America/Lima respecto a UTC (UTC-5, sin horario de verano). */
const LIMA_UTC_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pared-de-reloj de Lima para un instante: un Date cuyo calendario UTC coincide con lo que marca
 * el reloj en Lima. Truco estándar del repo (analytics.service) para operar calendarios sin ICU.
 */
function limaWallClock(now: Date): Date {
  return new Date(now.getTime() - LIMA_UTC_OFFSET_MS);
}

/** Instante UTC real a partir de un timestamp de pared-de-reloj Lima (deshace el corrimiento). */
function fromLimaWallClock(wallMs: number): Date {
  return new Date(wallMs + LIMA_UTC_OFFSET_MS);
}

/** Día natural de Lima que contiene a `now`: [00:00 hoy, 00:00 mañana) hora de Lima. */
export function dayWindow(now: Date): TimeWindow {
  const wall = limaWallClock(now);
  const startWall = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  return { start: fromLimaWallClock(startWall), end: fromLimaWallClock(startWall + DAY_MS) };
}

/** Semana de Lima en curso que contiene a `now`: [lunes 00:00, lunes+7 00:00) hora de Lima. */
export function weekWindow(now: Date): TimeWindow {
  const wall = limaWallClock(now);
  const dayWall = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  const dow = new Date(dayWall).getUTCDay(); // 0=domingo..6=sábado
  const daysSinceMonday = (dow + 6) % 7;
  const startWall = dayWall - daysSinceMonday * DAY_MS;
  return { start: fromLimaWallClock(startWall), end: fromLimaWallClock(startWall + 7 * DAY_MS) };
}

/** Mes calendario de Lima en curso que contiene a `now`: [día 1 00:00, día 1 del mes siguiente 00:00) Lima. */
export function monthWindow(now: Date): TimeWindow {
  const wall = limaWallClock(now);
  const startWall = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), 1);
  // Date.UTC normaliza mes 12 → enero del año siguiente, así que el cambio dic→ene sale solo.
  const endWall = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 1);
  return { start: fromLimaWallClock(startWall), end: fromLimaWallClock(endWall) };
}

/**
 * Las 7 ventanas de día natural de la SEMANA en curso (lunes→domingo, hora de Lima), en orden y
 * contiguas. Cubren exactamente `weekWindow(now)`: la primera arranca en el lunes de la semana y
 * cada elemento es un día [00:00, +24h) Lima (offset fijo sin DST ⇒ SIEMPRE 24h exactas). Útil
 * para la serie diaria del bar chart de ganancias.
 */
export function weekDailyWindows(now: Date): TimeWindow[] {
  const { start } = weekWindow(now);
  const windows: TimeWindow[] = [];
  for (let i = 0; i < 7; i += 1) {
    const dayStart = new Date(start.getTime() + i * DAY_MS);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    windows.push({ start: dayStart, end: dayEnd });
  }
  return windows;
}
