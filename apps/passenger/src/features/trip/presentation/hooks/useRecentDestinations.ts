import type { GeoPoint, TripHistoryItem, TripResource } from '@veo/api-client';
import { useMemo } from 'react';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import { useTripHistory } from './useTripHistory';

/** Máximo de destinos recientes mostrados como atajos en el peek. */
const MAX_RECENTS = 3;

/** Extrae destinos recientes únicos del historial local (recursos reales del bff). */
export function recentDestinations(trips: TripResource[]): TripResource['destination'][] {
  const seen = new Set<string>();
  const result: TripResource['destination'][] = [];
  for (const trip of trips) {
    const key = `${trip.destination.lat.toFixed(5)},${trip.destination.lon.toFixed(5)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(trip.destination);
    }
    if (result.length >= MAX_RECENTS) {
      break;
    }
  }
  return result;
}

/**
 * Extrae destinos recientes únicos del HISTORIAL REAL del backend (`GET /trips/history`). El destino del
 * item es `historyGeoPoint` (lng); convertimos a `GeoPoint` (lon) en el borde. Así las recientes reflejan
 * tus viajes REALES (sincronizados, no se pierden al reinstalar) en vez del snapshot local.
 */
export function recentDestinationsFromHistory(items: TripHistoryItem[]): GeoPoint[] {
  const seen = new Set<string>();
  const result: GeoPoint[] = [];
  for (const item of items) {
    const point: GeoPoint = { lat: item.destination.lat, lon: item.destination.lng };
    const key = `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(point);
    }
    if (result.length >= MAX_RECENTS) {
      break;
    }
  }
  return result;
}

/**
 * RECIENTES desde el BACKEND REAL (`GET /trips/history`, compartido/cacheado con el tab Historial):
 * tus destinos recientes salen de tus viajes REALES. Si el backend aún no respondió o no hay historial
 * (offline/primer uso), cae al snapshot local — degradación honesta, sin pantalla vacía.
 */
export function useRecentDestinations(): GeoPoint[] {
  const history = useDependency(TOKENS.tripHistoryRepository);
  const tripHistory = useTripHistory();
  return useMemo(() => {
    const fromBackend = recentDestinationsFromHistory(tripHistory.items);
    return fromBackend.length > 0 ? fromBackend : recentDestinations(history.list());
  }, [tripHistory.items, history]);
}
