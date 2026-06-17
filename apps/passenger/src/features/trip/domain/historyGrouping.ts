import {calendarDaysAgo} from '../../../shared/utils/format';

/**
 * Tramos temporales del historial (mata la monotonía de una lista plana). El orden de la unión ES el
 * orden de aparición de las secciones: lo más reciente arriba. Las etiquetas las resuelve la
 * presentación vía i18n (`history.section.*`).
 */
export type HistorySectionId = 'today' | 'week' | 'earlier';

/** Lo mínimo que agrupamos por tiempo: una marca temporal ISO de cuándo se pidió el viaje. */
export interface TimeGroupable {
  requestedAt: string;
}

export interface HistorySection<T extends TimeGroupable = TimeGroupable> {
  id: HistorySectionId;
  data: T[];
}

const ORDER: readonly HistorySectionId[] = ['today', 'week', 'earlier'];

/** Tramo de un viaje según los días de calendario desde `now` (0 = hoy, 1–6 = esta semana, resto antes). */
function sectionFor(trip: TimeGroupable, now: Date): HistorySectionId {
  const days = calendarDaysAgo(trip.requestedAt, now);
  if (days === null || days >= 7) {
    return 'earlier';
  }
  if (days <= 0) {
    return 'today';
  }
  return 'week';
}

/**
 * Agrupa los viajes (ya ordenados desc por `requestedAt` desde el server) en tramos temporales para una
 * `SectionList`. PURA y determinista (testeable, `now` inyectable). Omite los tramos vacíos: una
 * persona con un solo viaje de hoy ve UN header "Hoy", no tres secciones huecas. Genérica sobre cualquier
 * cosa con `requestedAt` (sirve para el `TripHistoryItem` del server y para snapshots locales).
 */
export function groupTripsByTime<T extends TimeGroupable>(
  trips: readonly T[],
  now: Date = new Date(),
): HistorySection<T>[] {
  const buckets: Record<HistorySectionId, T[]> = {
    today: [],
    week: [],
    earlier: [],
  };
  for (const trip of trips) {
    buckets[sectionFor(trip, now)].push(trip);
  }
  return ORDER.map(id => ({id, data: buckets[id]})).filter(
    section => section.data.length > 0,
  );
}
