import type {GeoPoint, NearbyVehicle} from '@veo/api-client';
import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {useMemo} from 'react';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';

/** Cada cuánto se re-consulta el ambiente de autitos (ms). 10s = vivo sin castigar batería/red. */
const POLL_INTERVAL_MS = 10_000;
/**
 * `staleTime` ALINEADO al intervalo: el dato vale por toda la ventana del poll, así un re-montaje del
 * mapa (cambio de fase idle↔searching) NO dispara un fetch extra; se sirve la última lista cacheada.
 */
const STALE_TIME_MS = POLL_INTERVAL_MS;
/**
 * Cuantización de la coordenada del queryKey a 3 decimales (~111m). El GPS DRIFTEA metro a metro entre
 * fixes; sin esto, cada micro-cambio de `point` sería un queryKey nuevo → un fetch nuevo. El backend ya
 * redondea la SALIDA a ~110m, así que pedir con precisión sub-100m no aporta nada. Redondear la ENTRADA
 * estabiliza la clave y deduplica los polls a la misma celda.
 */
const KEY_PRECISION = 1000; // 3 decimales

/**
 * Cuantiza una coordenada a 3 decimales (~111m) para usarla en el `queryKey`. Exportada para testear la
 * estabilidad de la clave (dos fixes dentro de la misma celda → misma clave → un solo fetch).
 */
export function quantizeCoord(value: number): number {
  return Math.round(value * KEY_PRECISION) / KEY_PRECISION;
}

export interface UseNearbyVehiclesResult {
  /** Autitos de ambiente (anónimos). SIEMPRE una lista: en error/carga es `[]`, nunca undefined. */
  vehicles: NearbyVehicle[];
}

/**
 * Polling de los vehículos cercanos ANÓNIMOS para pintar como AMBIENTE del mapa del pasajero.
 *
 *  - `point`   → centro de la consulta (la ubicación del usuario). `null` mientras no hay fix.
 *  - `enabled` → la presentación lo gatea por FASE: solo `idle` o `searching` (en viaje el único auto
 *                es el asignado). Sin `point` o deshabilitado, el query no corre.
 *
 * `queryKey` por coords CUANTIZADAS a ~3 decimales (no por el `point` crudo) para no re-fetchear por
 * cada metro de drift del GPS. Refetch cada 10s mientras está montado y habilitado. En ERROR: lista
 * VACÍA silenciosa — el caso de uso ya traga el fallo (es ambiente, nunca un banner de error).
 */
export function useNearbyVehicles(
  point: GeoPoint | null,
  enabled: boolean,
): UseNearbyVehiclesResult {
  const getNearby = useDependency(TOKENS.getNearbyVehiclesUseCase);

  // Clave cuantizada: estable mientras el usuario no cruce de celda de ~111m.
  const keyLat = point ? quantizeCoord(point.lat) : null;
  const keyLon = point ? quantizeCoord(point.lon) : null;

  // El query consulta con la coord CUANTIZADA (misma celda → misma respuesta del backend redondeado).
  const queryPoint = useMemo<GeoPoint | null>(
    () =>
      keyLat != null && keyLon != null ? {lat: keyLat, lon: keyLon} : null,
    [keyLat, keyLon],
  );

  const query = useQuery({
    queryKey: ['dispatch', 'nearby', keyLat, keyLon],
    queryFn: () => getNearby.execute(queryPoint as GeoPoint),
    enabled: enabled && queryPoint != null,
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: STALE_TIME_MS,
    // Al moverse de celda, conserva los autitos previos hasta que llega la nueva lista (sin parpadeo).
    placeholderData: keepPreviousData,
  });

  return {vehicles: query.data ?? []};
}
