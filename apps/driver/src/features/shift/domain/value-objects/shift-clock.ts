/**
 * Reloj de turno (duración "en la calle"). El backend NO expone `startedAt` en el estado de turno
 * (`GET /drivers/shift/state` solo trae `driverId` + `status`), así que la duración del turno se mide
 * del lado del cliente: se sella la marca de inicio al abrir turno y se lee al cerrarlo. Estas funciones
 * son PURAS (sin I/O) para poder testear el redondeo/formato; la persistencia vive en la capa de estado.
 */

/** Minutos transcurridos entre el inicio del turno y `now` (piso, nunca negativo). */
export function shiftElapsedMinutes(startedAtMs: number, nowMs: number): number {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) {
    return 0;
  }
  return Math.max(0, Math.floor((nowMs - startedAtMs) / 60_000));
}

/**
 * Formato LARGO para el subtítulo del resumen: "6 h 12 min", "45 min", "1 h". Omite la parte que sea 0
 * (no muestra "0 min" tras una hora exacta, ni "0 h" bajo la hora).
 */
export function formatShiftDurationLong(totalMinutes: number): string {
  const minutes = Math.max(0, Math.floor(totalMinutes));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours <= 0) {
    return `${mins} min`;
  }
  if (mins === 0) {
    return `${hours} h`;
  }
  return `${hours} h ${mins} min`;
}

/**
 * Formato CORTO para la celda "En turno" del grid: "6.2 h" a partir de una hora; "45 min" por debajo.
 * A partir de 60 min se muestra en horas con un decimal (como el frame: "6.2 h").
 */
export function formatShiftDurationShort(totalMinutes: number): string {
  const minutes = Math.max(0, Math.floor(totalMinutes));
  if (minutes < 60) {
    return `${minutes} min`;
  }
  return `${(minutes / 60).toFixed(1)} h`;
}
