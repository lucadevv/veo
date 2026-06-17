import {tripStatus} from '@veo/api-client';
import {useQuery} from '@tanstack/react-query';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {useTripHistory} from './useTripHistory';

/**
 * Conductor del ÚLTIMO viaje del pasajero, listo para pintar la tarjeta de confianza del Home idle
 * (avatar + nombre + vehículo + rating). `null` cuando no hay un viaje válido del que derivarlo: la
 * tarjeta NO se muestra (degradación HONESTA, sin inventar datos).
 */
export interface LastDriver {
  tripId: string;
  /** Nombre visible del conductor (puede faltar si el detalle aún no lo resolvió). */
  name: string | null;
  /** Etiqueta del vehículo "Marca Modelo" si el detalle la trae. */
  vehicleLabel: string | null;
  /** Rating 0..5 del conductor, o `null` si no se conoce. */
  rating: number | null;
}

export interface UseLastDriverResult {
  /** El conductor del último viaje COMPLETED con conductor, o `null` si no hay. */
  driver: LastDriver | null;
  /** Primera carga (historial + detalle): la tarjeta puede ocultarse hasta tener dato. */
  isLoading: boolean;
}

/**
 * HONESTIDAD del dato (clave): la lista del historial (`TripHistoryItem`) NO trae nombre/rating del
 * conductor — es anti-N+1 a propósito y solo expone `driverId`. Para la tarjeta del último conductor
 * tomamos el ÚLTIMO viaje COMPLETED con conductor y pedimos su DETALLE (`getActiveTrip(tripId)` →
 * `TripActiveView`, que sí enriquece `driver.name`/`driver.rating` + `vehicle`). El historial ya viene
 * ordenado DESC por fecha, así que el primer COMPLETED con `driverId` es el más reciente.
 *
 * Si no hay historial, ni un COMPLETED con conductor, devolvemos `null` (la tarjeta no renderiza). Si
 * el detalle falla o aún no tiene nombre, igual mostramos lo que haya (nombre `null` → el componente
 * decide); nunca fabricamos un conductor.
 */
export function useLastDriver(): UseLastDriverResult {
  const tripRepository = useDependency(TOKENS.tripRepository);
  const {items, isLoading: historyLoading} = useTripHistory();

  // Último viaje COMPLETED con conductor (la lista ya viene DESC por requestedAt).
  const lastTrip = items.find(
    trip => trip.status === tripStatus.enum.COMPLETED && trip.driverId != null,
  );
  const tripId = lastTrip?.id ?? null;

  // Detalle on-demand SOLO de ese viaje: trae el nombre/rating del conductor que la lista omite.
  const detailQuery = useQuery({
    queryKey: ['trip', tripId, 'last-driver'],
    queryFn: () => tripRepository.getActiveTrip(tripId as string),
    enabled: Boolean(tripId),
    staleTime: 5 * 60_000,
  });

  if (!lastTrip) {
    return {driver: null, isLoading: historyLoading};
  }

  const detail = detailQuery.data;
  const vehicleLabel = detail?.vehicle
    ? `${detail.vehicle.make} ${detail.vehicle.model}`
    : null;

  return {
    driver: {
      tripId: lastTrip.id,
      name: detail?.driver?.name ?? null,
      vehicleLabel,
      rating: detail?.driver?.rating ?? null,
    },
    isLoading: historyLoading || detailQuery.isLoading,
  };
}
