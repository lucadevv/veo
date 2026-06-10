import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useRepositories} from '../../../../core/di/useDi';
import {SHIFT_STATE_QUERY_KEY} from '../../../shift/presentation/hooks/useShift';
import {
  AcceptOfferUseCase,
  AcceptTripUseCase,
  ArrivedTripUseCase,
  ArrivingTripUseCase,
  CancelTripUseCase,
  CompleteTripUseCase,
  EnsureTripAcceptedUseCase,
  GetOfferUseCase,
  GetTripRouteUseCase,
  GetTripUseCase,
  RejectOfferUseCase,
  StartTripUseCase,
  type CompleteTripInput,
  type Trip,
} from '../../domain';

/** Prefijo de caché de viajes (para invalidación masiva desde realtime). */
export const TRIP_QUERY_PREFIX = ['trip'] as const;
export const tripQueryKey = (tripId: string) => ['trip', tripId] as const;
export const tripRouteQueryKey = (tripId: string) => ['trip', tripId, 'route'] as const;
export const offerQueryKey = (matchId: string) => ['offer', matchId] as const;

/** Query: detalle de la oferta entrante. */
export function useOffer(matchId: string) {
  const {trips} = useRepositories();
  return useQuery({
    queryKey: offerQueryKey(matchId),
    queryFn: () => new GetOfferUseCase(trips).execute(matchId),
  });
}

/** Query: viaje activo (lado conductor). */
export function useTrip(tripId: string) {
  const {trips} = useRepositories();
  return useQuery({
    queryKey: tripQueryKey(tripId),
    queryFn: () => new GetTripUseCase(trips).execute(tripId),
  });
}

/**
 * Query: ruta + pasos de navegación turn-by-turn del viaje activo. Solo se activa (`enabled`) cuando
 * el viaje está realmente en marcha (el llamador pasa `enabled`), porque la ruta solo aporta valor
 * mientras el conductor navega. Refresca cada 30 s para reflejar recálculos del servidor.
 */
export function useTripRoute(tripId: string, enabled: boolean) {
  const {trips} = useRepositories();
  return useQuery({
    queryKey: tripRouteQueryKey(tripId),
    queryFn: () => new GetTripRouteUseCase(trips).execute(tripId),
    enabled,
    staleTime: 15_000,
    refetchInterval: enabled ? 30_000 : false,
  });
}

/** Mutación: aceptar la oferta entrante (dispatch). */
export function useAcceptOffer() {
  const {trips} = useRepositories();
  return useMutation({
    mutationFn: (matchId: string) => new AcceptOfferUseCase(trips).execute(matchId),
  });
}

/** Mutación: rechazar la oferta entrante (dispatch). */
export function useRejectOffer() {
  const {trips} = useRepositories();
  return useMutation({
    mutationFn: (matchId: string) => new RejectOfferUseCase(trips).execute(matchId),
  });
}

/**
 * Mutación: garantizar ASSIGNED→ACCEPTED tras aceptar la oferta (cierra el GAP 2). Sondea el estado
 * hasta verlo ASSIGNED y confirma la asignación; idempotente si el viaje ya está ACCEPTED o más allá.
 * Refresca la caché del viaje con el resultado del servidor.
 */
export function useEnsureTripAccepted(tripId: string) {
  const {trips} = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => new EnsureTripAcceptedUseCase(trips).execute(tripId),
    onSuccess: trip => {
      if (trip) {
        queryClient.setQueryData(tripQueryKey(tripId), trip);
      } else {
        queryClient.invalidateQueries({queryKey: tripQueryKey(tripId)});
      }
      queryClient.invalidateQueries({queryKey: SHIFT_STATE_QUERY_KEY});
    },
  });
}

/**
 * Conjunto de acciones de la máquina de estados del viaje. Cada transición refresca la caché del
 * viaje (con el resultado del servidor) e invalida el estado de turno (puede pasar a/desde ON_TRIP).
 */
export function useTripActions(tripId: string) {
  const {trips} = useRepositories();
  const queryClient = useQueryClient();

  const onTrip = (trip: Trip) => {
    queryClient.setQueryData(tripQueryKey(tripId), trip);
    queryClient.invalidateQueries({queryKey: SHIFT_STATE_QUERY_KEY});
  };

  const accept = useMutation({
    mutationFn: () => new AcceptTripUseCase(trips).execute(tripId),
    onSuccess: onTrip,
  });
  const arriving = useMutation({
    mutationFn: () => new ArrivingTripUseCase(trips).execute(tripId),
    onSuccess: onTrip,
  });
  const arrived = useMutation({
    mutationFn: () => new ArrivedTripUseCase(trips).execute(tripId),
    onSuccess: onTrip,
  });
  const start = useMutation({
    mutationFn: (childCode?: string) => new StartTripUseCase(trips).execute(tripId, childCode),
    onSuccess: onTrip,
  });
  const complete = useMutation({
    mutationFn: (input?: CompleteTripInput) => new CompleteTripUseCase(trips).execute(tripId, input),
    onSuccess: onTrip,
  });
  const cancel = useMutation({
    mutationFn: (reason?: string) => new CancelTripUseCase(trips).execute(tripId, reason),
    onSuccess: onTrip,
  });

  return {accept, arriving, arrived, start, complete, cancel};
}
