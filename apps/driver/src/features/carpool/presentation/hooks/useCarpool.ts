import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import {
  ApproveBookingUseCase,
  CancelTripUseCase,
  GetMyTripsUseCase,
  GetTripBookingsUseCase,
  PublishTripUseCase,
  RejectBookingUseCase,
  UpdateTripUseCase,
  type PublishTripInput,
  type UpdateTripInput,
} from '../../domain';

/** Clave raíz del namespace de carpooling en la caché de react-query. */
export const CARPOOL_QUERY_KEY = ['carpool'] as const;
/** Clave de caché de mis ofertas publicadas. */
export const CARPOOL_TRIPS_QUERY_KEY = ['carpool', 'trips'] as const;
/** Clave de caché de las solicitudes de un viaje (factory por tripId). */
export const carpoolBookingsQueryKey = (tripId: string) => ['carpool', 'bookings', tripId] as const;

/** Query: mis ofertas de carpooling publicadas. */
export function useMyPublishedTrips() {
  const { carpool } = useRepositories();
  return useQuery({
    queryKey: CARPOOL_TRIPS_QUERY_KEY,
    queryFn: () => new GetMyTripsUseCase(carpool).execute(),
  });
}

/** Query: solicitudes entrantes de un viaje propio. Deshabilitada hasta tener `tripId`. */
export function useTripBookings(tripId: string | undefined) {
  const { carpool } = useRepositories();
  return useQuery({
    queryKey: carpoolBookingsQueryKey(tripId ?? ''),
    queryFn: () => new GetTripBookingsUseCase(carpool).execute(tripId as string),
    enabled: !!tripId,
  });
}

/** Mutation: publicar una nueva oferta. Invalida la lista de mis viajes al éxito. */
export function usePublishTrip() {
  const { carpool } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PublishTripInput) => new PublishTripUseCase(carpool).execute(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CARPOOL_TRIPS_QUERY_KEY }),
  });
}

/** Mutation: editar una oferta PUBLICADA. Invalida la lista de mis viajes al éxito. */
export function useUpdateTrip() {
  const { carpool } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ tripId, input }: { tripId: string; input: UpdateTripInput }) =>
      new UpdateTripUseCase(carpool).execute(tripId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CARPOOL_TRIPS_QUERY_KEY }),
  });
}

/** Mutation: cancelar una de mis ofertas. Invalida la lista de mis viajes al éxito. */
export function useCancelTrip() {
  const { carpool } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tripId: string) => new CancelTripUseCase(carpool).execute(tripId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CARPOOL_TRIPS_QUERY_KEY }),
  });
}

/**
 * Mutation: aprobar una solicitud. Invalida las solicitudes del viaje (cambia el estado) y la lista
 * de mis viajes (aprobar decrementa `asientosDisponibles`). Recibe `tripId` para invalidar la key.
 */
export function useApproveBooking() {
  const { carpool } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bookingId }: { bookingId: string; tripId: string }) =>
      new ApproveBookingUseCase(carpool).execute(bookingId),
    onSuccess: (_data, { tripId }) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: carpoolBookingsQueryKey(tripId) }),
        queryClient.invalidateQueries({ queryKey: CARPOOL_TRIPS_QUERY_KEY }),
      ]),
  });
}

/** Mutation: rechazar una solicitud. Invalida las solicitudes del viaje al éxito. */
export function useRejectBooking() {
  const { carpool } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bookingId }: { bookingId: string; tripId: string }) =>
      new RejectBookingUseCase(carpool).execute(bookingId),
    onSuccess: (_data, { tripId }) =>
      queryClient.invalidateQueries({ queryKey: carpoolBookingsQueryKey(tripId) }),
  });
}
