import { useEffect } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { GeoPoint, TripHistoryItem } from '@veo/api-client';
import { useRepositories } from '../../../../core/di/useDi';
import { SHIFT_STATE_QUERY_KEY } from '../../../shift/domain';
import {
  EARNINGS_BREAKDOWN_QUERY_KEY,
  EARNINGS_DAILY_QUERY_KEY,
  EARNINGS_SUMMARY_QUERY_KEY,
} from '../../../earnings/domain';
import {
  ACTIVE_TRIP_QUERY_KEY,
  COMMISSION_RATE_QUERY_KEY,
  TRIP_QUERY_PREFIX,
  tripQueryKey,
  AcceptOfferUseCase,
  AcceptTripUseCase,
  ArrivedTripUseCase,
  ArrivingTripUseCase,
  CancelTripUseCase,
  CompleteTripUseCase,
  EnsureTripAcceptedUseCase,
  GetActiveTripUseCase,
  GetCommissionRateUseCase,
  GetOfferUseCase,
  GetTripHistoryUseCase,
  GetTripRouteUseCase,
  GetTripStateUseCase,
  GetTripUseCase,
  isTripTerminal,
  parseTripStatus,
  RejectOfferUseCase,
  StartTripUseCase,
  type CompleteTripInput,
  type Trip,
} from '../../domain';

// `TRIP_QUERY_PREFIX`, `tripQueryKey` y `ACTIVE_TRIP_QUERY_KEY` viven ahora en `trips/domain`
// (cache compartido con chat/realtime). Se re-exportan para no romper a los consumidores del barrel.
export { ACTIVE_TRIP_QUERY_KEY, TRIP_QUERY_PREFIX, tripQueryKey };
/**
 * Resolución de re-ruteo: la posición del conductor se CUANTIZA a ~4 decimales (≈11 m por décima de
 * milésima) antes de entrar en la queryKey. Así react-query solo RE-FETCHea la ruta cuando el conductor
 * se movió de verdad (no en cada micro-jitter del GPS) = ETA vivo + re-ruteo por desvío sin sobrecargar
 * al BFF. `null` cuando no hay posición (sin GPS): la ruta sale del origen del viaje (degradación honesta).
 */
const ROUTE_POSITION_PRECISION = 4;
const quantize = (n: number) => Number(n.toFixed(ROUTE_POSITION_PRECISION));

export const tripRouteQueryKey = (tripId: string, from?: GeoPoint) =>
  [
    'trip',
    tripId,
    'route',
    from ? quantize(from.lat) : null,
    from ? quantize(from.lon) : null,
  ] as const;
export const offerQueryKey = (matchId: string) => ['offer', matchId] as const;

/** Query: detalle de la oferta entrante. */
export function useOffer(matchId: string) {
  const { trips } = useRepositories();
  return useQuery({
    queryKey: offerQueryKey(matchId),
    queryFn: () => new GetOfferUseCase(trips).execute(matchId),
  });
}

/**
 * Query: viaje ACTIVO del conductor para REHIDRATAR tras un reinicio (sin conocer el id). `null` si no
 * tiene ninguno en curso. Server-authoritative: la app no recuerda el viaje en memoria volátil, lo
 * deriva del servidor al (re)arrancar. La consume `RealtimeManager` para volver al viaje + reanudar.
 */
export function useActiveTrip() {
  const { trips } = useRepositories();
  return useQuery({
    queryKey: ACTIVE_TRIP_QUERY_KEY,
    queryFn: () => new GetActiveTripUseCase(trips).execute(),
  });
}

/**
 * Query: viaje activo (lado conductor). Inactiva con `tripId` vacío (p. ej. sin viaje activo).
 *
 * `retry: 3` cubre la CARRERA post-accept: el gate anti-IDOR del BFF responde 404 si `GetTrip` corre
 * ANTES de que el commit de la asignación fije el driverId — un tick después ya es 200. Sin retry, esa
 * ventana de milisegundos tiraba la pantalla del viaje recién aceptado a "Algo salió mal" (visto en
 * vivo). Tres reintentos con el backoff default (~1-4 s) la absorben; un 404 REAL (viaje ajeno) solo
 * paga ese mismo backoff antes del error honesto.
 */
/** Clave de caché del estado ligero del viaje (poll de respaldo; mismo patrón que el pasajero). */
export const tripStateQueryKey = (tripId: string) => ['trip', tripId, 'state'] as const;

/** Cadencia del poll de respaldo de estado (espeja los 5 s del `useOfferBoard` del pasajero). */
const TRIP_STATE_POLL_MS = 5_000;

export function useTrip(tripId: string) {
  const { trips } = useRepositories();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: tripQueryKey(tripId),
    queryFn: () => new GetTripUseCase(trips).execute(tripId),
    enabled: tripId.length > 0,
    retry: 3,
  });

  // Poll de RESPALDO del estado mientras el viaje sigue VIVO. El socket `/driver` es la vía primaria,
  // pero si se pierde UN `trip:update` (zona muerta, túnel caído) nada re-sincroniza: el namespace no
  // reemite snapshot y esta query no refetchea sola → el conductor quedaba congelado en ACCEPTED/ARRIVED
  // stale para siempre (p. ej. ante una cancelación del pasajero). `GET /trips/:id/state` es barato y
  // el poll se apaga solo al llegar a un estado terminal.
  const cachedStatus = query.data ? parseTripStatus(query.data.status) : null;
  const pollEnabled =
    tripId.length > 0 && cachedStatus !== null && !isTripTerminal(cachedStatus);
  const stateQuery = useQuery({
    queryKey: tripStateQueryKey(tripId),
    queryFn: () => new GetTripStateUseCase(trips).execute(tripId),
    enabled: pollEnabled,
    refetchInterval: pollEnabled ? TRIP_STATE_POLL_MS : false,
  });

  // Divergencia detectada (el poll vio un status que el detalle cacheado no tiene) → invalidar el
  // detalle del viaje: la pantalla reacciona por el refetch igual que hoy ante un `trip:update`
  // (incluida la salida al dashboard si el nuevo estado es terminal).
  const polledStatus = stateQuery.data ? parseTripStatus(stateQuery.data.status) : null;
  useEffect(() => {
    if (polledStatus !== null && cachedStatus !== null && polledStatus !== cachedStatus) {
      queryClient.invalidateQueries({ queryKey: tripQueryKey(tripId) });
    }
  }, [polledStatus, cachedStatus, tripId, queryClient]);

  return query;
}

/** Clave de caché del historial paginado del conductor (una sola "lista infinita"). */
export const TRIP_HISTORY_QUERY_KEY = ['trips', 'history'] as const;

/** Tamaño de página pedido al BFF (el servidor lo acota a su tope; es solo una sugerencia). */
const TRIP_HISTORY_PAGE_SIZE = 20;

/** Estado aplanado del historial que consume la pantalla (mismo contrato que el hook del pasajero). */
export interface UseTripHistoryResult {
  /** Items de todas las páginas cargadas, aplanados y en orden del servidor (requestedAt DESC). */
  items: TripHistoryItem[];
  /** Primera carga sin datos: la pantalla pinta el skeleton. */
  isLoading: boolean;
  /** Error de la primera carga: la pantalla pinta el estado reintentable. */
  isError: boolean;
  /** Hay página siguiente (nextCursor != null). */
  hasNextPage: boolean;
  /** Se está trayendo la página siguiente (footer "cargando más"). */
  isFetchingNextPage: boolean;
  /** Pull-to-refresh en curso (con datos ya en pantalla). */
  isRefetching: boolean;
  /** Pide la página siguiente (idempotente si ya carga o no hay más). */
  fetchNextPage: () => void;
  /** Reintenta desde cero (error) o refresca (pull-to-refresh). */
  refetch: () => void;
}

/**
 * Historial de viajes del CONDUCTOR leído del SERVIDOR con paginación infinita por CURSOR (keyset).
 *
 * Espeja el `useTripHistory` del pasajero: cada página trae `{ items, nextCursor }`; `getNextPageParam`
 * devuelve `nextCursor ?? undefined` (undefined corta la paginación → `hasNextPage` pasa a false). El
 * cursor es OPACO — se re-pasa tal cual sin parsearlo. Server-authoritative: los ESTADOS son los reales
 * (COMPLETED/CANCELLED/EXPIRED), no una foto local. Sin fallback offline a propósito (HONESTO): sin red se
 * muestra error reintentable, no datos viejos como si fueran verdad.
 */
export function useTripHistory(): UseTripHistoryResult {
  const { trips } = useRepositories();

  const query = useInfiniteQuery({
    queryKey: TRIP_HISTORY_QUERY_KEY,
    queryFn: ({ pageParam }) =>
      new GetTripHistoryUseCase(trips).execute({
        cursor: pageParam ?? undefined,
        limit: TRIP_HISTORY_PAGE_SIZE,
      }),
    initialPageParam: undefined as string | undefined,
    // `null` (sin más) → undefined corta la paginación; un cursor opaco se re-pasa tal cual.
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 60_000,
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  return {
    items,
    isLoading: query.isLoading,
    isError: query.isError,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isRefetching: query.isRefetching,
    fetchNextPage: () => {
      // Solo pide si hay más y no hay una página en vuelo (evita disparos dobles al llegar al fondo).
      if (query.hasNextPage && !query.isFetchingNextPage) {
        void query.fetchNextPage();
      }
    },
    refetch: () => {
      void query.refetch();
    },
  };
}

/**
 * Query: ruta + pasos de navegación turn-by-turn del viaje activo. Solo se activa (`enabled`) cuando
 * el viaje está realmente en marcha (el llamador pasa `enabled`), porque la ruta solo aporta valor
 * mientras el conductor navega.
 *
 * `from` (posición ACTUAL del conductor) entra CUANTIZADA en la queryKey: cuando el conductor avanza
 * lo suficiente (≈11 m), react-query re-fetchea y la ruta se RE-CALCULA desde su nueva posición = ETA
 * en vivo + próxima maniobra viva + re-ruteo por desvío. El `refetchInterval` de 15 s es el fallback
 * (recálculos del servidor / GPS quieto). Sin `from`: ruta desde el origen del viaje (degradación honesta).
 */
export function useTripRoute(tripId: string, enabled: boolean, from?: GeoPoint) {
  const { trips } = useRepositories();
  // Cuantizamos ANTES de pasar al repo para que la posición enviada al BFF coincida con la de la
  // queryKey (misma celda ⇒ mismo fetch; sin esto la URL variaría con jitter sub-métrico que la key ignora).
  const quantized: GeoPoint | undefined = from
    ? { lat: quantize(from.lat), lon: quantize(from.lon) }
    : undefined;
  return useQuery({
    queryKey: tripRouteQueryKey(tripId, quantized),
    queryFn: () => new GetTripRouteUseCase(trips).execute(tripId, quantized),
    enabled,
    staleTime: 15_000,
    refetchInterval: enabled ? 15_000 : false,
    // El `from` cuantizado vive EN la queryKey: manejando a velocidad normal la key cambia cada ~1 s
    // (celda de ~11 m) y react-query la trata como query NUEVA → sin esto `data` era undefined durante
    // CADA refetch y la ruta PARPADEABA en el mapa (desaparecía la polyline, el fit re-encuadraba, el
    // banner de maniobra se caía). Con keepPreviousData la ruta anterior queda pintada hasta que llega
    // la recalculada — el mapa nunca se queda sin ruta mientras navega.
    placeholderData: keepPreviousData,
  });
}

/**
 * Query: tasa de comisión ON-DEMAND VIGENTE (panel admin → payment-service → driver-bff). La consumen
 * los desgloses bruto − comisión (TripComplete/TripDetail). staleTime generoso: la config cambia poco y
 * el BFF ya la cachea 60 s; mientras la primera carga no resuelve (o sin red), el desglose degrada al
 * fallback offline (`FALLBACK_COMMISSION_RATE`) vía `commissionRateFromBps(undefined)`.
 */
export function useCommissionRate() {
  const { trips } = useRepositories();
  return useQuery({
    queryKey: COMMISSION_RATE_QUERY_KEY,
    queryFn: () => new GetCommissionRateUseCase(trips).execute(),
    staleTime: 5 * 60_000,
  });
}

/** Mutación: aceptar la oferta entrante (dispatch). */
export function useAcceptOffer() {
  const { trips } = useRepositories();
  return useMutation({
    mutationFn: (matchId: string) => new AcceptOfferUseCase(trips).execute(matchId),
  });
}

/** Mutación: rechazar la oferta entrante (dispatch). */
export function useRejectOffer() {
  const { trips } = useRepositories();
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
  const { trips } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => new EnsureTripAcceptedUseCase(trips).execute(tripId),
    onSuccess: (trip) => {
      if (trip) {
        queryClient.setQueryData(tripQueryKey(tripId), trip);
      } else {
        queryClient.invalidateQueries({ queryKey: tripQueryKey(tripId) });
      }
      queryClient.invalidateQueries({ queryKey: SHIFT_STATE_QUERY_KEY });
    },
  });
}

/**
 * Conjunto de acciones de la máquina de estados del viaje. Cada transición refresca la caché del
 * viaje (con el resultado del servidor) e invalida el estado de turno (puede pasar a/desde ON_TRIP).
 */
export function useTripActions(tripId: string) {
  const { trips } = useRepositories();
  const queryClient = useQueryClient();

  const onTrip = (trip: Trip) => {
    queryClient.setQueryData(tripQueryKey(tripId), trip);
    queryClient.invalidateQueries({ queryKey: SHIFT_STATE_QUERY_KEY });
    // La RUTA depende de la FASE (onboard ⇒ el recojo se cae de la geometría): cada transición la
    // re-pide YA. Sin esto, tras "Iniciar viaje" el mapa seguía mostrando el tramo al recojo hasta el
    // próximo poll de 15 s (o >11 m de movimiento). Prefijo sin posición: invalida TODAS las celdas.
    queryClient.invalidateQueries({ queryKey: ['trip', tripId, 'route'] });
    // La PLATA impacta recién al CERRARSE el viaje (completado; el cancelado puede generar cargo): el
    // "Neto de hoy" del dashboard sale de earnings/summary y NADIE lo invalidaba tras completar → el
    // conductor volvía al panel con el neto viejo hasta un remount. Se invalidan las TRES vistas de
    // ganancias (resumen + desglose + serie diaria; mismo criterio que `onTipAdded`), solo en terminal
    // para no refetchear ganancias en cada transición intermedia (el dashboard sigue montado bajo el stack).
    if (isTripTerminal(parseTripStatus(trip.status))) {
      queryClient.invalidateQueries({ queryKey: EARNINGS_SUMMARY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: EARNINGS_BREAKDOWN_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: EARNINGS_DAILY_QUERY_KEY });
    }
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
    mutationFn: (input?: CompleteTripInput) =>
      new CompleteTripUseCase(trips).execute(tripId, input),
    onSuccess: onTrip,
  });
  const cancel = useMutation({
    mutationFn: (reason?: string) => new CancelTripUseCase(trips).execute(tripId, reason),
    onSuccess: onTrip,
  });

  return { accept, arriving, arrived, start, complete, cancel };
}
