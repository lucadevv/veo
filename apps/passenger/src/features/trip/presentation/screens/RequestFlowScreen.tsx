import type { DebtView, GeoPoint, MapPoint, OfferView, PlaceSuggestion, TripHistoryItem, TripResource } from '@veo/api-client';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Avatar,
  Banner,
  Card,
  IconButton,
  ListItem,
  RoutePin,
  SearchField,
  Skeleton,
  SosButton,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import type { RootStackParamList } from '../../../../navigation/types';
import { AppMap } from '../../../../shared/presentation/components/AppMap';
import {
  DraggableSheet,
  type DraggableSheetHandle,
} from '../../../../shared/presentation/components/DraggableSheet';
import { isWaypointSet, type RoutePlace } from '../../../maps/domain/entities';
import { useNearbyVehicles } from '../../../dispatch/presentation/hooks/useNearbyVehicles';
import { useAutocomplete } from '../../../maps/presentation/hooks/useAutocomplete';
import { useRideDraftStore } from '../../../maps/presentation/stores/rideDraftStore';
import type { SavedPlace } from '../../../places/domain/entities';
import { SavedPlacesShortcuts } from '../../../places/presentation';
import { useSavedPlacesStore } from '../../../places/presentation/stores/savedPlacesStore';
import { DebtSheet, useMyDebts } from '../../../payments/presentation';
import { formatPEN } from '../../../../shared/utils/format';
import { EnterView } from '../components/motion';
import { QuotingBody } from '../components/QuotingBody';
import { usePushPermission } from '../../../notifications/presentation/hooks/usePushPermission';
import { PushPrePrompt } from '../../../notifications/presentation/components/PushPrePrompt';
import { useTripHistory } from '../hooks/useTripHistory';
import { OffersBody } from '../components/OffersBody';
import { ActiveTripBody } from '../components/ActiveTripBody';
import { LiveBadge } from '../components/LiveBadge';
import { CompletionBody } from '../components/CompletionBody';
import { NoOffersBody } from '../components/NoOffersBody';
import { usePanicAutoTrigger } from '../../../panic/presentation';
import {
  IconArrowLeft,
  IconBell,
  IconChat,
  IconClose,
  IconHome,
  IconPin,
  IconPlus,
  IconSearch,
  IconStar,
  IconTarget,
  IconWork,
  type GlyphProps,
} from '../components/icons';
import { useCurrentLocation } from '../hooks/useCurrentLocation';
import { usePassengerTripSocket } from '../hooks/usePassengerTripSocket';
import { useWaypointProposal } from '../hooks/useWaypointProposal';
import { useOfferBoard } from '../hooks/useOfferBoard';
import { useHydrateActiveTrip } from '../hooks/useHydrateActiveTrip';
import { resolveTripPhase, mapModeForPhase, isLiveSocketPhase } from '../hooks/tripFlowPhase';
import { resolveMapDirective } from '../hooks/mapDirector';
import { useActiveTripStore } from '../stores/activeTripStore';

/** Convierte el punto del borrador (MapPoint, lng) al GeoPoint (lon) que consume el AppMap. */
function draftToGeo(place: { point: MapPoint } | null): GeoPoint | null {
  return place ? { lat: place.point.lat, lon: place.point.lng } : null;
}

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Modo del sheet: `idle` (home con atajos) o `searching` (búsqueda plegada DENTRO del mismo sheet). */
type FlowState = 'idle' | 'searching';

/** Máximo de destinos recientes mostrados como atajos en el peek. */
const MAX_RECENTS = 3;

/**
 * Bottom sheet ARRASTRABLE anclado al borde inferior (estilo DraggableScrollableSheet de Flutter), con
 * DOS anclajes:
 *  - `'content'` (peek): altura ADAPTATIVA — abraza el contenido real (buscador + chips + guardados +
 *    recientes), capado a `PEEK_MAX_FRACTION`. Pocos ítems → peek chico; sin guardados → mínimo. Si el
 *    contenido supera el tope, se queda en el tope y se ve más arrastrando hacia arriba.
 *  - `0.92` (expandido): casi pantalla completa; la lista entera, scrolleable.
 * La BÚSQUEDA es una pantalla aparte (`Search`), abierta al tocar el buscador.
 */
const SNAP_POINTS = ['content', 0.92] as const;
const PEEK_MAX_FRACTION = 0.5;
const PEEK_INDEX = 0;
const FULL_INDEX = SNAP_POINTS.length - 1;

/** Extrae destinos recientes únicos del historial local (recursos reales del bff). */
function recentDestinations(trips: TripResource[]): TripResource['destination'][] {
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
function recentDestinationsFromHistory(items: TripHistoryItem[]): GeoPoint[] {
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

/** Convierte un lugar guardado en el `RoutePlace` que consume el borrador. */
function placeToRoute(place: SavedPlace): RoutePlace {
  return {
    point: place.point,
    title: place.label,
    ...(place.subtitle ? { subtitle: place.subtitle } : {}),
  };
}

/** Convierte una sugerencia de autocompletado en el `RoutePlace` que consume el borrador. */
function suggestionToRoute(suggestion: PlaceSuggestion): RoutePlace {
  return {
    point: { lat: suggestion.lat, lng: suggestion.lng },
    title: suggestion.title,
    subtitle: suggestion.subtitle,
  };
}

/**
 * Pantalla del tab "Pedir viaje". El mapa es PERSISTENTE de fondo y sobre él flota un `DraggableSheet`
 * ADAPTATIVO (abraza su contenido: buscador + chips + guardados + recientes; scrollea si lo supera).
 *
 *  - `idle` (peek/expandido): atajos de 1 toque (chips Casa/Trabajo, guardados, recientes) → fijan
 *    destino y van a `RouteQuote`.
 *  - `searching`: tocar el buscador EXPANDE el MISMO sheet y pliega la búsqueda adentro (input con
 *    autofocus + "usar mi ubicación" + sugerencias). Recién al ELEGIR un destino navega a `RouteQuote`.
 *    No se navega a otra pantalla para buscar — todo ocurre en el sheet.
 */
export function RequestFlowScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  // Alto del tab bar: el sheet ancla por encima de él (no queda tapado el fondo del contenido).
  const tabBarHeight = useBottomTabBarHeight();

  const reverseGeocode = useDependency(TOKENS.reverseGeocodeUseCase);
  const getProfile = useDependency(TOKENS.getProfileUseCase);
  const history = useDependency(TOKENS.tripHistoryRepository);
  const tripRepository = useDependency(TOKENS.tripRepository);

  const { point: myLocation, status: locationStatus, retry: retryLocation } = useCurrentLocation();
  const origin = useRideDraftStore((s) => s.origin);
  const destination = useRideDraftStore((s) => s.destination);
  const waypoints = useRideDraftStore((s) => s.waypoints);
  const setOrigin = useRideDraftStore((s) => s.setOrigin);
  const setDestination = useRideDraftStore((s) => s.setDestination);
  const setEditing = useRideDraftStore((s) => s.setEditing);
  const resetDraft = useRideDraftStore((s) => s.reset);
  const savedPlaces = useSavedPlacesStore((s) => s.places);

  // Alto visible del peek (lo reporta el sheet): se lo pasamos al mapa como paddingBottom para que el
  // pin del usuario quede en la franja visible por encima del sheet, no tapado por él.
  const [peekHeight, setPeekHeight] = useState(0);
  const sheetRef = useRef<DraggableSheetHandle>(null);
  // Modo del sheet (idle ↔ searching) + texto de búsqueda. flowRef evita closures rancios en handleSnap.
  const [flow, setFlow] = useState<FlowState>('idle');
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const [query, setQuery] = useState('');
  // Geometría de la ruta del quote (la reporta QuotingBody) para que el AppMap persistente la dibuje.
  const [routeCoords, setRouteCoords] = useState<[number, number][]>([]);
  // DEUDA (BR-P02): el sheet de deuda y su origen. `debtFromBlockedRequest` distingue si lo abrió un
  // pedido bloqueado (403) —entonces, tras saldar, RE-INTENTAMOS el pedido— de la franja del home (solo
  // cerrar). `requestAgainToken` se incrementa para que QuotingBody re-dispare el create solo.
  const [debtSheetOpen, setDebtSheetOpen] = useState(false);
  const [debtFromBlockedRequest, setDebtFromBlockedRequest] = useState(false);
  const [requestAgainToken, setRequestAgainToken] = useState(0);
  // Viaje VIVO del pasajero. Vive en un store (no useState) para SOBREVIVIR al desmontaje del tab Home
  // (detachInactiveScreens): al volver, el sheet re-entra al viaje. La fuente de verdad es el server.
  const activeTripId = useActiveTripStore((s) => s.activeTripId);
  const setActiveTripId = useActiveTripStore((s) => s.setActiveTripId);
  const clearActiveTrip = useActiveTripStore((s) => s.clear);

  // Re-entrada: al enfocar (montaje + volver al tab), rehidrata el viaje activo desde el server.
  useHydrateActiveTrip();

  // Estado en vivo del viaje (socket /passenger). Conecta SOLO en fases VIVAS (gateado por `socketEnabled`,
  // que se sincroniza con la fase más abajo): con `activeTripId` pero el viaje ya COMPLETED (re-entrada al
  // cierre/settlement) NO hay nada que escuchar por este canal y el gateway del BFF rechaza el handshake en
  // loop —el recibo se refresca por poll REST—. Mientras el socket está apagado, `live` queda en INITIAL y
  // la fase se deriva del poll REST de estado (useOfferBoard), así que NO se rompe el tracking del viaje.
  const [socketEnabled, setSocketEnabled] = useState(false);
  const live = usePassengerTripSocket(activeTripId ?? '', socketEnabled);

  // Vuelve al home LIMPIO (cierre canónico del ciclo): limpia el viaje activo, el borrador
  // (origen/destino → fase a idle), la ruta dibujada en el mapa Y el estado local del sheet (modo
  // búsqueda + texto). Sin esto, tras "Volver al inicio" podían quedar restos (flow='searching' o un
  // query viejo) y el home no reaparecía pulcro para pedir OTRO viaje. El snap del sheet vuelve a peek
  // solo, vía el efecto de `expandedPhase` (completed→idle apaga el full). Es el ÚNICO punto de reset.
  const clearTrip = useCallback(() => {
    clearActiveTrip();
    resetDraft();
    setRouteCoords([]);
    setFlow('idle');
    setQuery('');
  }, [clearActiveTrip, resetDraft]);

  // Board de la PUJA (ofertas en vivo + aceptar/cancelar). El match (status ASSIGNED) lo maneja la
  // navegación interina por fase; cancelar vuelve al home.
  const board = useOfferBoard(activeTripId, live, {
    onAccepted: () => undefined,
    onCancelled: clearTrip,
  });

  // FASE del flujo (máquina central, única fuente de verdad). Lotes 1-2: idle/quoting/searching/offers
  // y el VIAJE ACTIVO (enRoute/arrived/inProgress) viven en el sheet; el resto navega INTERINO (lote 3).
  const phase = resolveTripPhase({
    hasDestination: Boolean(destination),
    activeTripId,
    status: board.status,
    offerCount: board.offers.length,
  });
  const isActiveTrip = phase === 'enRoute' || phase === 'arrived' || phase === 'inProgress';

  // Gatea el socket por FASE: solo lo abrimos en fases vivas (puja + viaje activo). En `completed`/cierre
  // o `idle`/`quoting` lo cerramos. La fase se deriva del poll REST de estado cuando el socket está apagado,
  // por eso este lazo converge (apagado → REST dice COMPLETED → fase completed → sigue apagado). El socket
  // arranca un render DESPUÉS de entrar a una fase viva (latencia despreciable: el REST ya alimenta la UI).
  useEffect(() => {
    setSocketEnabled(isLiveSocketPhase(phase));
  }, [phase]);

  // AMBIENTE: autitos cercanos anónimos alrededor del pasajero. En idle (home), searching (buscando
  // conductores) Y completed (vuelve el ambiente al cerrar el ciclo); en cotización y viaje activo el
  // mapa tiene su propio foco (el único auto es el asignado). Centro = la ubicación del usuario. El hook
  // ya degrada a lista vacía en error (nunca un banner): es decoración del mapa.
  const showNearby = phase === 'idle' || phase === 'searching' || phase === 'completed';
  const { vehicles: nearbyVehicles } = useNearbyVehicles(myLocation, showNearby);

  // Detalle del viaje (conductor/vehículo/tarifa) para el cuerpo del viaje activo Y el cierre (pago/rating).
  const tripDetailQuery = useQuery({
    queryKey: ['trip', activeTripId, 'active'],
    queryFn: () => tripRepository.getActiveTrip(activeTripId as string),
    enabled: Boolean(activeTripId) && (isActiveTrip || phase === 'completed'),
    refetchInterval: live.ended ? false : 15_000,
  });

  // PARADA negociada mid-trip (Lote C3): el pasajero propone una parada durante el viaje EN CURSO. El
  // hook posee el picking (el tap del mapa → `addStop.pickPoint`), el POST y la máquina de la propuesta.
  // El OUTCOME en vivo (aceptó/rechazó/venció) llega por el socket `/passenger` (Lote C4); el hook lo
  // consume para cerrar el "esperando". Si el socket está caído, el vencimiento local sigue resolviendo.
  const queryClient = useQueryClient();
  const addStop = useWaypointProposal(activeTripId ?? '', live.waypointOutcome);

  // Al ACEPTARSE la parada, el viaje cambió server-side (ruta + paradas + tarifa): refrescamos el detalle
  // para que el mapa y la tarifa reflejen lo nuevo sin esperar al poll de 15 s.
  useEffect(() => {
    if (addStop.phase === 'accepted' && activeTripId) {
      void queryClient.invalidateQueries({ queryKey: ['trip', activeTripId, 'active'] });
    }
  }, [addStop.phase, activeTripId, queryClient]);

  // COREOGRAFÍA DEL MAPA POR FASE (helper puro). Decide qué markers muestra y cómo encuadra la cámara
  // (fit conductor+recogida / follow taxi / center). El AppMap solo recibe props simples (showUserPoint,
  // cameraTarget, …). El vehicleType del conductor NO viene en TripActiveView (solo make/model/plate) →
  // CAR por defecto (decisión del dueño: "si no hay tipo, CAR"). Memoizado por las coords que driftean
  // para no reconstruir el target en cada render del padre.
  // Memoizados por el RoutePlace del store (referencia estable salvo que cambien). Se pasan al AppMap
  // (React.memo): sin memo, un objeto nuevo por render rompía el memo y empujaba props nuevas al GL thread
  // del mapa en cada keystroke del buscador / cambio de peekHeight. Un solo origen para route y trip mode.
  const originGeo = useMemo(() => draftToGeo(origin), [origin]);
  const destinationGeo = useMemo(() => draftToGeo(destination), [destination]);
  // Paradas intermedias (Ola 2B) para pintarlas en el MAPA del flujo principal (antes solo iban al
  // RouteQuoteScreen legacy). Filtramos los placeholders vacíos y convertimos lng→lon.
  const waypointsGeo = useMemo(
    () =>
      waypoints
        .filter(isWaypointSet)
        .map(draftToGeo)
        .filter((p): p is GeoPoint => p !== null),
    [waypoints],
  );
  // FUENTE ÚNICA (§5-bis): en el VIAJE ACTIVO las paradas las manda el TRIP DEL SERVIDOR (las MISMAS que
  // ve el conductor), NO el borrador local — que podría divergir. El contrato `tripActiveView.waypoints`
  // ya viene como GeoPoint {lat,lon} (sin conversión). [] mientras el detalle no cargó o si el viaje es
  // directo: degradación honesta (línea recta, sin crash). En COTIZACIÓN sigue mandando `waypointsGeo`.
  const serverWaypointsGeo = useMemo<GeoPoint[]>(
    () => tripDetailQuery.data?.waypoints ?? [],
    [tripDetailQuery.data?.waypoints],
  );
  const mapDirective = useMemo(
    () =>
      resolveMapDirective({
        phase,
        driver: live.driverLocation ?? null,
        origin: originGeo,
        destination: destinationGeo,
        userPoint: myLocation,
        vehicleType: 'CAR',
        hasRoute: routeCoords.length > 1,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      phase,
      live.driverLocation?.lat,
      live.driverLocation?.lon,
      originGeo?.lat,
      originGeo?.lon,
      destinationGeo?.lat,
      destinationGeo?.lon,
      myLocation?.lat,
      myLocation?.lon,
      routeCoords.length,
    ],
  );

  // Pánico nativo (triple volumen): armado SOLO durante el viaje activo (se desarma fuera).
  usePanicAutoTrigger(activeTripId ?? '', isActiveTrip);

  // Chat con el conductor: drena los no leídos y abre la pantalla de chat.
  const unreadCount = live.incomingMessages.length;
  const openChat = useCallback(() => {
    live.acknowledgeMessages(live.incomingMessages.map((m) => m.id));
    navigation.navigate('Chat', { tripId: activeTripId as string });
  }, [live, navigation, activeTripId]);

  const myPoint = useMemo<MapPoint | null>(
    () => (myLocation ? { lat: myLocation.lat, lng: myLocation.lon } : null),
    [myLocation],
  );

  // Etiqueta legible de la ubicación actual (geocoding inverso real).
  const reverseQuery = useQuery({
    queryKey: ['maps', 'reverse', myPoint?.lat ?? null, myPoint?.lng ?? null],
    queryFn: () => reverseGeocode.execute(myPoint as MapPoint),
    enabled: Boolean(myPoint),
    staleTime: 60_000,
  });

  // Perfil para el avatar (foto real si existe).
  const profileQuery = useQuery({
    queryKey: ['profile', 'me'],
    queryFn: () => getProfile.execute(),
    staleTime: 5 * 60_000,
  });

  // Permiso de push para el PRE-PROMPT contextual: se ofrece cuando ya pediste el viaje y esperás
  // conductor (ahí el push importa), NO al entrar. Solo si nunca se decidió ('undetermined'). Una vez por
  // sesión (`pushPrePromptSeen`): "Ahora no" no insiste; el toggle del Perfil queda para activarlo luego.
  const push = usePushPermission();
  const [pushPrePromptSeen, setPushPrePromptSeen] = useState(false);

  // Siembra el origen del borrador con la ubicación actual etiquetada (centro INICIAL del mapa).
  useEffect(() => {
    if (!origin && reverseQuery.data) {
      setOrigin({
        point: { lat: reverseQuery.data.lat, lng: reverseQuery.data.lng },
        title: reverseQuery.data.title,
        subtitle: reverseQuery.data.subtitle,
      });
    }
  }, [origin, reverseQuery.data, setOrigin]);

  // ── MODELO CABIFY · recojo con PIN en el Home ──────────────────────────────────────────────────
  // En el Home idle el mapa es interactivo y un pin FIJO al centro marca el RECOJO: arrastrás el mapa y el
  // origen SIGUE al centro (reverse-geocode en vivo). Antes el origen se clavaba al GPS sin forma de
  // elegir el punto. `pickupMode` = Home idle (no buscando, no en cotización/viaje).
  const pickupMode = phase === 'idle' && flow !== 'searching';
  // Centro VIVO que reporta el AppMap al hacer pan (throttle interno 120ms).
  const [pickupCenter, setPickupCenter] = useState<GeoPoint | null>(null);
  // Centro INICIAL del mapa idle: se captura UNA vez (GPS) y NO se actualiza → un refresh de GPS no hace
  // snap-back que deshaga el pan del usuario (mismo patrón que MapPick).
  const [pickupInitial, setPickupInitial] = useState<GeoPoint | null>(null);
  useEffect(() => {
    if (!pickupInitial && myLocation) setPickupInitial(myLocation);
  }, [pickupInitial, myLocation]);
  // Debounce del centro → reverse-geocode → el origen sigue al pin. Solo en pickupMode. Degradación
  // honesta: si el reverse falla (red), se conserva el origen previo (no inventamos una dirección).
  useEffect(() => {
    if (!pickupMode || !pickupCenter) return;
    const id = setTimeout(() => {
      void reverseGeocode
        .execute({ lat: pickupCenter.lat, lng: pickupCenter.lon })
        .then((place) =>
          setOrigin({
            point: { lat: pickupCenter.lat, lng: pickupCenter.lon },
            title: place.title,
            subtitle: place.subtitle,
          }),
        )
        .catch(() => undefined);
    }, 350);
    return () => clearTimeout(id);
  }, [pickupMode, pickupCenter, reverseGeocode, setOrigin]);

  // RECIENTES desde el BACKEND REAL (`GET /trips/history`, compartido/cacheado con el tab Historial):
  // tus destinos recientes salen de tus viajes REALES (sincronizados, no se pierden al reinstalar). Si el
  // backend aún no respondió o no hay historial (offline/primer uso), cae al snapshot local — degradación
  // honesta, sin pantalla vacía.
  const tripHistory = useTripHistory();
  const recents = useMemo(() => {
    const fromBackend = recentDestinationsFromHistory(tripHistory.items);
    return fromBackend.length > 0 ? fromBackend : recentDestinations(history.list());
  }, [tripHistory.items, history]);

  // Autocompletado real (debounce + sesgo por ubicación), activo solo cuando hay texto.
  const { suggestions, loading: searchLoading, error: searchError, active } = useAutocomplete(query, myPoint);

  // Tocar el buscador EXPANDE el sheet y entra a modo búsqueda DENTRO del mismo sheet (no navega).
  const enterSearch = useCallback(() => {
    setEditing({ kind: 'destination' });
    setQuery('');
    setFlow('searching');
    sheetRef.current?.snapToIndex(FULL_INDEX);
  }, [setEditing]);

  // Sale de búsqueda y vuelve al peek (X o arrastrar hasta abajo).
  const exitSearch = useCallback(() => {
    setFlow('idle');
    setQuery('');
    sheetRef.current?.snapToIndex(PEEK_INDEX);
  }, []);

  // El DRAG no entra a búsqueda (eso es solo por tap): arrastrar mueve la lista idle entre peek y
  // expandido. ÚNICA transición por drag: si estás buscando y arrastrás hasta el peek, sale de búsqueda.
  const handleSnap = useCallback((index: number) => {
    if (flowRef.current === 'searching' && index <= PEEK_INDEX) {
      setFlow('idle');
      setQuery('');
    }
  }, []);

  // Atajo de 1 toque (chips/guardados/recientes) o elegir una sugerencia: fija el destino y la fase
  // pasa a 'quoting' EN EL MISMO sheet (no navega). Sale del modo búsqueda.
  const selectDestination = useCallback(
    (place: RoutePlace) => {
      setDestination(place);
      setFlow('idle');
      setQuery('');
    },
    [setDestination],
  );

  // Volver de la cotización al home: limpia el destino (la fase vuelve a idle), conserva el origen.
  const cancelQuoting = useCallback(() => {
    setDestination(null);
    setRouteCoords([]);
  }, [setDestination]);

  // El viaje se creó: NO navega → setea activeTripId y el sheet reacciona (searching/offers in-sheet).
  // No reseteamos el borrador: el mapa sigue mostrando origen/destino/ruta durante la búsqueda.
  const onTripCreated = useCallback(
    (trip: TripResource) => {
      history.record(trip);
      setActiveTripId(trip.id);
    },
    [history, setActiveTripId],
  );

  // Elegir una oferta del board: ACCEPT_PRICE → aceptar (match); COUNTER → contraoferta (INTERINO Lote 3).
  const onChooseOffer = useCallback(
    (offer: OfferView) => {
      if (board.acceptMutation.isPending) return;
      if (offer.kind === 'COUNTER') {
        navigation.navigate('Counter', { tripId: activeTripId as string, driverId: offer.driverId });
      } else {
        board.acceptMutation.mutate(offer.driverId);
      }
    },
    [board.acceptMutation, navigation, activeTripId],
  );

  const onScheduled = useCallback(() => {
    resetDraft();
    setRouteCoords([]);
    navigation.navigate('ScheduledTrips');
  }, [resetDraft, navigation]);

  const onKycRequired = useCallback(() => navigation.navigate('KycCamera'), [navigation]);

  // DEUDA · señal PASIVA: consulta las deudas SOLO en el home idle (no en viaje/cotización) para no
  // golpear el endpoint en cada pantalla. Alimenta la franja sutil del home y siembra el DebtSheet.
  const debtsQuery = useMyDebts(phase === 'idle');
  const hasDebt = debtsQuery.data?.hasDebt ?? false;
  // Vista de deuda para el sheet: la real del endpoint. Si el 403 abrió el sheet antes de que la query
  // resuelva, igual cae el fetch (enabled en idle) y la completa; el sheet salda la más antigua.
  const debtView: DebtView | null = debtsQuery.data ?? null;

  // PAGO POR COMPLETAR (PENDING_ACTION): el primer cobro PENDING con checkout vivo (no es deuda). Solo lo
  // ofrecemos en la franja si NO hay deuda (la deuda es lo accionable urgente y tiene prioridad). Es el
  // dead-end que resolvemos: un pago a medias al que ahora se puede VOLVER desde el home.
  const firstPendingAction = debtView?.debts.find((d) => d.kind === 'PENDING_ACTION') ?? null;
  const hasPendingAction = !hasDebt && firstPendingAction != null;

  // Cuando el sheet se abre para un PAGO POR COMPLETAR, este id le dice que cargue el cobro fresco y abra
  // su checkout directo (en vez del flujo de deuda). null = sheet en modo deuda.
  const [pendingActionPaymentId, setPendingActionPaymentId] = useState<string | null>(null);

  // El 403 DEBT_PENDING bloqueó un pedido → abre el sheet de deuda (origen: pedido) en vez de un error.
  const onDebtPending = useCallback(() => {
    setPendingActionPaymentId(null);
    setDebtFromBlockedRequest(true);
    setDebtSheetOpen(true);
    // Asegura datos frescos de la deuda para el sheet (el gate es server-side; refrescamos el detalle).
    void debtsQuery.refetch();
  }, [debtsQuery]);

  // Franja del home (DEUDA) → abre el MISMO sheet (origen: home, sin pedido que reintentar).
  const openDebtFromHome = useCallback(() => {
    setPendingActionPaymentId(null);
    setDebtFromBlockedRequest(false);
    setDebtSheetOpen(true);
  }, []);

  // Franja del home (PAGO POR COMPLETAR) → abre el sheet en modo PENDING_ACTION: checkout directo del cobro.
  const openPendingFromHome = useCallback(() => {
    if (!firstPendingAction) {
      return;
    }
    setPendingActionPaymentId(firstPendingAction.paymentId);
    setDebtFromBlockedRequest(false);
    setDebtSheetOpen(true);
  }, [firstPendingAction]);

  const closeDebtSheet = useCallback(() => setDebtSheetOpen(false), []);

  // Deuda SALDADA: cierra el sheet. Si vino de un pedido bloqueado, RE-INTENTA el pedido solo (incrementa
  // el token que QuotingBody observa); si vino del home, solo cierra (la franja desaparece sola al
  // invalidarse la caché de deudas dentro del DebtSheet).
  const onDebtSettled = useCallback(() => {
    setDebtSheetOpen(false);
    setPendingActionPaymentId(null);
    if (debtFromBlockedRequest) {
      setRequestAgainToken((n) => n + 1);
      setDebtFromBlockedRequest(false);
    }
  }, [debtFromBlockedRequest]);

  // Snap por fase: la COTIZACIÓN y el CIERRE (pago/rating) van a full (forms largos con confirmar).
  // Ofertas, viaje activo, idle Y la PUJA SIN OFERTAS van a PEEK content-hug: el sheet ABRAZA su
  // contenido (NoOffersBody es chico) → el mapa SIEMPRE queda visible arriba (regla del dueño: la
  // altura del sheet es DINÁMICA según el contenido, no pantalla completa). El body de noOffers entra
  // dentro de maxContentFraction (50%); si algún día no entrara, se achica el body, no se fuerza full.
  const expandedPhase = phase === 'quoting' || phase === 'completed';
  useEffect(() => {
    sheetRef.current?.snapToIndex(expandedPhase ? FULL_INDEX : PEEK_INDEX);
  }, [expandedPhase]);

  // PUENTE INTERINO (Lote 4 pendiente): SOLO la reasignación AÚN navega a su pantalla y resetea el
  // screen a idle. El viaje ACTIVO (enRoute/arrived/inProgress), el CIERRE (completado → pago+rating) y
  // ahora la PUJA SIN OFERTAS (noOffers → NoOffersBody) YA viven en el sheet (el flujo es UNO, ninguna
  // fase navega a otra pantalla); CANCELLED/FAILED (ended) limpian y vuelven al home.
  const handedOff = useRef(false);
  useEffect(() => {
    if (!activeTripId) {
      handedOff.current = false;
      return;
    }
    if (handedOff.current) return;
    const id = activeTripId;
    if (phase === 'reassigning') {
      handedOff.current = true;
      navigation.navigate('Reassign', { tripId: id });
      clearTrip();
    } else if (phase === 'ended') {
      handedOff.current = true;
      clearTrip();
    }
  }, [phase, activeTripId, navigation, clearTrip]);

  // "Usar mi ubicación actual" como destino (fila del modo búsqueda).
  const useCurrentAsDestination = useCallback(() => {
    if (reverseQuery.data) {
      selectDestination({
        point: { lat: reverseQuery.data.lat, lng: reverseQuery.data.lng },
        title: reverseQuery.data.title,
        subtitle: reverseQuery.data.subtitle,
      });
    }
  }, [reverseQuery.data, selectDestination]);

  // "Ver todas" → pantallas de gestión existentes (lugares guardados / historial de viajes).
  const goSavedPlaces = useCallback(() => navigation.navigate('SavedPlaces'), [navigation]);
  const goTripHistory = useCallback(
    () => navigation.navigate('Main', { screen: 'TripHistory' }),
    [navigation],
  );

  // Estado de la pastilla de ubicación: cada estado no-feliz da un mensaje + CTA accionable
  // (Ajustes para permiso/GPS, Reintentar para fix fallido), en vez de un genérico mudo.
  const locationActionable =
    locationStatus === 'denied' || locationStatus === 'servicesOff' || locationStatus === 'error';
  const userLabel =
    locationStatus === 'denied'
      ? t('home.locationDenied')
      : locationStatus === 'servicesOff'
        ? t('home.locationServicesOff')
        : locationStatus === 'error'
          ? t('home.locationUnavailable')
          : origin?.title ??
            reverseQuery.data?.title ??
            (locationStatus === 'locating' ? t('home.locating') : t('home.yourLocation'));
  // La acción del pill: permiso/GPS → abrir Ajustes del sistema; fix fallido → reintentar en el acto.
  const locationActionLabel =
    locationStatus === 'error'
      ? t('home.locationActionRetry')
      : locationActionable
        ? t('home.locationActionSettings')
        : null;
  const onLocationAction = useCallback(() => {
    if (locationStatus === 'error') {
      retryLocation();
    } else if (locationStatus === 'denied' || locationStatus === 'servicesOff') {
      void Linking.openSettings();
    }
  }, [locationStatus, retryLocation]);

  // Encuadre del mapa memoizado (mismo objeto para route y trip mode): un literal inline se recreaba en
  // cada render y rompía el React.memo del AppMap. Solo cambia con el safe-area top o el alto del peek.
  const fitEdgePadding = useMemo(
    () => ({ top: insets.top + 40, bottom: peekHeight + 16, left: 40, right: 40 }),
    [insets.top, peekHeight],
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.bg }]}>
      {/* MAPA PERSISTENTE ÚNICO: nunca se desmonta; reacciona a la fase (idle=pin / route=ruta / trip=auto). */}
      <View style={StyleSheet.absoluteFill}>
        {mapModeForPhase(phase) === 'route' ? (
          <AppMap
            origin={originGeo}
            destination={destinationGeo}
            waypoints={waypointsGeo}
            // Ambiente solo en searching (la otra fase 'route' es quoting, donde no van autitos).
            nearbyVehicles={showNearby ? nearbyVehicles : undefined}
            routeCoordinates={routeCoords.length > 1 ? routeCoords : undefined}
            fitToRoute={routeCoords.length > 1}
            // Encuadre dinámico: reserva abajo el alto del PEEK para que la ruta no quede tapada. El AppMap
            // TOPA ese bottom (CAP duro) para que un sheet alto (ofertas) no aplaste el viewport y aleje la
            // cámara de más. Paddings APRETADOS (40 top/lados, gusto del dueño "más encima"): cierran el
            // encuadre de ruta sin que los pins toquen el borde. Rutas cortas las absorbe FIT_MAX_ZOOM.
            fitEdgePadding={fitEdgePadding}
            interactive={false}
          />
        ) : mapModeForPhase(phase) === 'trip' ? (
          <AppMap
            // En viaje en curso el marker de origen es ruido (ya pasamos por la recogida); en pre-pickup
            // SÍ ayuda. El director decide el encuadre; los markers de origen/destino se mantienen para
            // contexto de la ruta (el destino siempre; el origen solo pre-pickup).
            origin={phase === 'inProgress' ? null : originGeo}
            destination={destinationGeo}
            // Viaje ACTIVO → paradas del SERVIDOR (fuente única), no del borrador local. Ver serverWaypointsGeo.
            // Durante el picking de una parada nueva (C3), el punto elegido se previsualiza como un pin más.
            waypoints={
              addStop.picking && addStop.pickedPoint
                ? [...serverWaypointsGeo, addStop.pickedPoint]
                : serverWaypointsGeo
            }
            // Picking de parada mid-trip: el tap del mapa fija el punto propuesto (solo mientras se elige).
            onPress={addStop.picking ? addStop.pickPoint : undefined}
            driver={live.driverLocation ?? null}
            driverHeading={live.driverHeading}
            driverVehicleType="CAR"
            showDriverVehicle={mapDirective.showDriverVehicle}
            showUserPoint={mapDirective.showUserPoint}
            userPoint={mapDirective.showUserPoint ? myLocation : null}
            // En completed vuelve el AMBIENTE (autitos cercanos) además del userPoint (cierre del ciclo).
            nearbyVehicles={mapDirective.showNearby ? nearbyVehicles : undefined}
            cameraTarget={mapDirective.cameraTarget ?? undefined}
            // La ruta al destino sigue dibujada también en curso (la baja el director como contexto).
            routeCoordinates={routeCoords.length > 1 ? routeCoords : undefined}
            // F3 · cuando el director NO dirige (cameraTarget null: aún sin conductor en pre-pickup/curso),
            // la Camera DECLARATIVA encuadra la ruta+markers (fitToRoute) en vez de quedar muda y derivar al
            // zoom-ciudad. Con conductor, manda el cameraTarget (director) y este fit se ignora. En
            // 'completed' (cameraTarget null pero sin querer fit de ruta) cae al center sobre mi ubicación.
            fitToRoute={mapDirective.cameraTarget == null && isActiveTrip}
            fitEdgePadding={fitEdgePadding}
            // El encuadre lo gobierna el cameraTarget (director) cuando dirige; si no, el fit declarativo.
            // El AppMap TOPA el bottomInset al CAP para el fit dirigido (enRoute conductor+recogida).
            bottomInset={peekHeight + 16}
            interactive
          />
        ) : (
          <AppMap
            center={pickupInitial ?? myLocation}
            onCenterChange={pickupMode ? setPickupCenter : undefined}
            userPoint={myLocation}
            nearbyVehicles={nearbyVehicles}
            interactive
            bottomInset={peekHeight}
          />
        )}
      </View>

      {/* MODELO CABIFY · pin FIJO al centro = punto de RECOJO (solo Home idle). No intercepta gestos
          (pointerEvents none) → el mapa se arrastra DEBAJO; el origen sigue al centro vía onCenterChange. */}
      {pickupMode ? (
        <View style={styles.pickupPinLayer} pointerEvents="none">
          <RoutePin variant="origin" size={22} />
        </View>
      ) : null}

      {/* Chrome superior del HOME (pill de ubicación + campana + avatar). Oculta durante el viaje activo. */}
      {!isActiveTrip ? (
      <View
        style={[styles.topRow, { top: insets.top + theme.spacing.sm }]}
        pointerEvents="box-none"
      >
        <Pressable
          accessibilityRole={locationActionable ? 'button' : undefined}
          accessibilityLabel={locationActionable ? `${userLabel}. ${locationActionLabel ?? ''}` : userLabel}
          onPress={locationActionable ? onLocationAction : undefined}
          disabled={!locationActionable}
          style={[
            styles.locationPill,
            {
              backgroundColor: theme.colors.surface,
              borderColor: locationActionable ? theme.colors.warn : theme.colors.border,
              borderRadius: theme.radii.pill,
              ...theme.elevation.level2,
            },
          ]}
        >
          <View
            style={[
              styles.locationDot,
              { backgroundColor: locationActionable ? theme.colors.warn : theme.colors.accent },
            ]}
          />
          <Text variant="subhead" numberOfLines={1} style={styles.locationLabel}>
            {userLabel}
          </Text>
          {locationActionLabel ? (
            <Text variant="subhead" color="accent" numberOfLines={1} style={styles.locationAction}>
              {locationActionLabel}
            </Text>
          ) : null}
        </Pressable>
        <View style={styles.topActions} pointerEvents="box-none">
          <IconButton
            accessibilityLabel={t('home.notifications')}
            variant="surface"
            onPress={() => navigation.navigate('Notifications')}
            icon={<IconBell color={theme.colors.ink} size={20} />}
            style={{ ...theme.elevation.level2 }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('screens.profile')}
            onPress={() => navigation.navigate('Main', { screen: 'Profile' })}
          >
            <Avatar
              uri={profileQuery.data?.photoUrl ?? undefined}
              name={profileQuery.data?.name ?? t('appName')}
              size="md"
            />
          </Pressable>
        </View>
      </View>
      ) : (
        // Chrome del VIAJE ACTIVO sobre el mapa: SOS (der.), pill "EN VIVO" (centro), chat (izq. + badge).
        <>
          <View style={[styles.tripSos, { top: insets.top + theme.spacing.sm, right: theme.spacing.lg }]}>
            <SosButton size={56} onPress={() => navigation.navigate('Panic', { tripId: activeTripId as string })} />
          </View>
          <View style={[styles.tripPill, { top: insets.top + theme.spacing.sm }]} pointerEvents="none">
            <LiveBadge />
          </View>
          <View style={[styles.tripChat, { top: insets.top + theme.spacing.sm, left: theme.spacing.lg }]}>
            <IconButton
              accessibilityLabel={t('chat.open')}
              variant="surface"
              onPress={openChat}
              icon={<IconChat color={theme.colors.ink} size={20} />}
            />
            {unreadCount > 0 ? (
              <View style={[styles.tripBadge, { backgroundColor: theme.colors.accent, borderColor: theme.colors.bg }]}>
                <Text variant="caption" color="onAccent" tabular>
                  {unreadCount > 9 ? '9+' : unreadCount}
                </Text>
              </View>
            ) : null}
          </View>
        </>
      )}

      {/* BOTTOMSHEET ARRASTRABLE anclado abajo. HEADER FIJO: en idle, buscador (tap → expande a búsqueda)
          + chips; en searching, input con autofocus + cerrar. BODY SCROLLABLE: guardados+recientes (idle)
          o "usar mi ubicación" + sugerencias (searching). Elegir destino → RouteQuote. */}
      <DraggableSheet
        ref={sheetRef}
        snapPoints={SNAP_POINTS}
        maxContentFraction={PEEK_MAX_FRACTION}
        onSnap={handleSnap}
        onPeekHeightChange={setPeekHeight}
        bottomOffset={tabBarHeight}
        renderHeader={() => {
          // WHITELIST: el header del HOME (buscador "¿A dónde vamos?" + chips Casa/Trabajo) o el header
          // de la cotización (volver + destino) SOLO existen en esas dos fases. Cualquier otra fase
          // —searching/offers/noOffers/reassigning, viaje activo, completed (cierre), ended— trae su
          // propio cuerpo autocontenido y NO debe mostrar el chrome del home encima (era el leak del
          // buscador filtrándose sobre el CompletionBody y el NoOffersBody).
          if (phase !== 'idle' && phase !== 'quoting') return null;
          return (
          <View style={[styles.header, { paddingHorizontal: theme.spacing.xl, gap: theme.spacing.sm }]}>
            {phase === 'quoting' ? (
              <View style={styles.searchHeader}>
                <IconButton
                  accessibilityLabel={t('actions.back')}
                  variant="surface"
                  onPress={cancelQuoting}
                  icon={<IconArrowLeft color={theme.colors.ink} size={22} />}
                />
                <Text variant="bodyStrong" numberOfLines={1} style={styles.searchInput}>
                  {destination?.title ?? t('home.destination')}
                </Text>
              </View>
            ) : flow === 'idle' ? (
              <>
                <SearchField
                  placeholder={t('home.whereTo')}
                  onPress={enterSearch}
                  leftIcon={<IconSearch color={theme.colors.accent} size={20} />}
                />
                <HomeShortcutChips savedPlaces={savedPlaces} onSelect={selectDestination} onAdd={goSavedPlaces} />
              </>
            ) : (
              <View style={styles.searchHeader}>
                <View style={styles.searchInput}>
                  <TextField
                    label={t('home.destination')}
                    placeholder={t('maps.inputPlaceholder')}
                    value={query}
                    onChangeText={setQuery}
                    autoFocus
                    autoCorrect={false}
                    returnKeyType="search"
                  />
                </View>
                <IconButton
                  accessibilityLabel={t('actions.close')}
                  onPress={exitSearch}
                  variant="surface"
                  icon={<IconClose color={theme.colors.inkMuted} size={20} />}
                />
              </View>
            )}
          </View>
          );
        }}
        renderScroll={(ScrollComponent) => (
          <ScrollComponent
            style={styles.sheetScroll}
            contentContainerStyle={[
              styles.sheetContent,
              {
                paddingHorizontal: theme.spacing.xl,
                // Respiro al final del scroll (el sheet ancla en bottom:0 y el área útil ya descuenta el
                // tab bar vía bottomOffset, así que no hace falta sumar su alto acá).
                paddingBottom: theme.spacing.xl,
                gap: theme.spacing.md,
              },
            ]}
            showsVerticalScrollIndicator={false}
          >
            {phase === 'quoting' ? (
              <QuotingBody
                onTripCreated={onTripCreated}
                onScheduled={onScheduled}
                onKycRequired={onKycRequired}
                onDebtPending={onDebtPending}
                onActiveTripExists={setActiveTripId}
                onRouteChange={setRouteCoords}
                requestAgainToken={requestAgainToken}
                kycStatus={profileQuery.data?.kycStatus ?? null}
              />
            ) : phase === 'searching' || phase === 'offers' ? (
              <OffersBody
                offers={board.offers}
                connected={board.connected}
                expired={board.status === 'EXPIRED'}
                // F2 · countdown AUTORITATIVO: vence cuando lo dice el board (epoch ms), no un reloj local.
                expiresAt={board.board?.expiresAt ?? null}
                isLoading={board.isLoading}
                isError={board.isError}
                onRetry={board.refetch}
                onChoose={onChooseOffer}
                choosing={board.acceptMutation.isPending}
                onCancel={() => board.cancelMutation.mutate()}
                cancelling={board.cancelMutation.isPending}
                actionError={board.actionError}
              />
            ) : isActiveTrip ? (
              tripDetailQuery.data ? (
                <ActiveTripBody
                  tripId={activeTripId as string}
                  trip={tripDetailQuery.data}
                  status={board.status ?? tripDetailQuery.data.status}
                  etaSeconds={live.etaSeconds}
                  onOpenCamera={() => navigation.navigate('CameraLive', { tripId: activeTripId as string })}
                  onCancelled={clearTrip}
                  addStop={addStop}
                />
              ) : (
                <Skeleton variant="rect" height={140} />
              )
            ) : phase === 'completed' ? (
              tripDetailQuery.data ? (
                <CompletionBody
                  tripId={activeTripId as string}
                  trip={tripDetailQuery.data}
                  onDone={clearTrip}
                />
              ) : (
                <Skeleton variant="rect" height={140} />
              )
            ) : phase === 'noOffers' ? (
              // PUJA SIN OFERTAS (EXPIRED): in-sheet, sin navegar. Re-pujar reabre el board (la fase
              // vuelve a 'searching' sola); Salir abandona la puja expirada y vuelve al home limpio.
              <NoOffersBody
                tripId={activeTripId as string}
                onRebid={() => undefined}
                onExit={clearTrip}
              />
            ) : flow === 'idle' ? (
              <>
                {/* Señal PASIVA del home (sin castigo) → abre el DebtSheet. La DEUDA tiene prioridad (warn +
                    monto + "Resolver"); si no hay deuda pero sí un PAGO POR COMPLETAR, franja info +
                    "Continuar" que abre el checkout directo (resuelve el dead-end del pago a medias). */}
                {hasDebt ? (
                  <DebtStrip
                    kind="debt"
                    amountCents={debtsQuery.data?.totalCents ?? 0}
                    onPress={openDebtFromHome}
                  />
                ) : hasPendingAction ? (
                  <DebtStrip kind="pendingAction" amountCents={0} onPress={openPendingFromHome} />
                ) : null}
                <IdleBody
                  savedPlaces={savedPlaces}
                  recents={recents}
                  onSelect={selectDestination}
                  onSeeAllSaved={goSavedPlaces}
                  onSeeAllRecents={goTripHistory}
                />
              </>
            ) : (
              <SearchingBody
                showCurrentLocation={Boolean(reverseQuery.data) && !active}
                currentLocationSubtitle={reverseQuery.data?.subtitle}
                onUseCurrentLocation={useCurrentAsDestination}
                suggestions={suggestions}
                loading={searchLoading}
                error={searchError}
                active={active}
                onSelectSuggestion={(s) => selectDestination(suggestionToRoute(s))}
                onSelectSaved={(p) => selectDestination(placeToRoute(p))}
              />
            )}
          </ScrollComponent>
        )}
      />

      {/* DEUDA (BR-P02): un único sheet para los dos orígenes (pedido bloqueado 403 / franja del home).
          Saldar → CAPTURED reabre el camino: si vino de un pedido, re-intentamos solo (requestAgainToken). */}
      <DebtSheet
        visible={debtSheetOpen}
        debt={debtView}
        pendingActionPaymentId={pendingActionPaymentId}
        onClose={closeDebtSheet}
        onSettled={onDebtSettled}
      />

      {/* Pre-prompt CONTEXTUAL de notificaciones: al estar BUSCANDO conductor (ahí el push importa) y solo
          si el permiso nunca se decidió ('undetermined'). Una vez por sesión; "Ahora no" no insiste. */}
      <PushPrePrompt
        visible={phase === 'searching' && push.status === 'undetermined' && !pushPrePromptSeen}
        onDismiss={() => setPushPrePromptSeen(true)}
        onEnable={() => {
          setPushPrePromptSeen(true);
          void push.enable();
        }}
      />
    </View>
  );
}

/* ─── Atajos Casa/Trabajo (chips horizontales · viven en el HEADER FIJO) ─── */

interface HomeShortcutChipsProps {
  savedPlaces: SavedPlace[];
  onSelect: (place: RoutePlace) => void;
  /** Sin Casa/Trabajo guardado: el chip lleva a agregarlo (pantalla de gestión). */
  onAdd: () => void;
}

/** Casa/Trabajo como pills de 1 toque (anclas, siempre visibles). Si falta, el chip invita a agregar. */
function HomeShortcutChips({ savedPlaces, onSelect, onAdd }: HomeShortcutChipsProps): React.JSX.Element {
  const { t } = useTranslation();
  const home = savedPlaces.find((p) => p.kind === 'HOME');
  const work = savedPlaces.find((p) => p.kind === 'WORK');
  return (
    <View style={styles.chipsRow}>
      <ShortcutChip
        label={t('home.shortcutHome')}
        Icon={IconHome}
        present={Boolean(home)}
        onPress={() => (home ? onSelect(placeToRoute(home)) : onAdd())}
      />
      <ShortcutChip
        label={t('home.shortcutWork')}
        Icon={IconWork}
        present={Boolean(work)}
        onPress={() => (work ? onSelect(placeToRoute(work)) : onAdd())}
      />
    </View>
  );
}

interface ShortcutChipProps {
  label: string;
  Icon: (props: GlyphProps) => React.JSX.Element;
  present: boolean;
  onPress: () => void;
}

function ShortcutChip({ label, Icon, present, onPress }: ShortcutChipProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[
        styles.chip,
        { backgroundColor: theme.colors.bg, borderColor: theme.colors.border, borderRadius: theme.radii.pill },
      ]}
    >
      {present ? (
        <Icon color={theme.colors.accent} size={18} />
      ) : (
        <IconPlus color={theme.colors.inkMuted} size={18} />
      )}
      <Text variant="subhead" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/* ─── Franja PASIVA del home (señal sutil): DEUDA o PAGO POR COMPLETAR ─── */

interface DebtStripProps {
  /**
   * `debt` = hay una DEUDA real (cobro en DEBT, bloquea pedir): franja warn con el monto + "Resolver".
   * `pendingAction` = hay un PAGO POR COMPLETAR (PENDING con checkout vivo, NO bloquea): franja info sin
   * monto + "Continuar" → abre el checkout directo. El home prioriza la deuda (es lo accionable urgente).
   */
  kind: 'debt' | 'pendingAction';
  /** Monto a mostrar (solo en `debt`). En `pendingAction` no mostramos monto: no es una cuenta a saldar. */
  amountCents: number;
  onPress: () => void;
}

/**
 * Señal PASIVA del home idle, sin castigo. Dos variantes:
 *  - DEUDA (warn sobrio): "Tienes un pago pendiente · S/ 23.00 — Resolver". Toca → DebtSheet (saldar).
 *  - PAGO POR COMPLETAR (info): "Tienes un pago por completar — Continuar". Toca → DebtSheet abre DIRECTO
 *    el checkout del cobro fresco (resuelve el dead-end del pago que quedó a medias).
 * El pasajero decide cuándo; la franja nunca bloquea desde el home.
 */
function DebtStrip({ kind, amountCents, onPress }: DebtStripProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const isDebt = kind === 'debt';
  // DEUDA → warn (sobrio, urgente). PAGO POR COMPLETAR → accent (el verde de la marca: invita, no alarma).
  const accentColor = isDebt ? theme.colors.warn : theme.colors.accent;
  const title = isDebt ? t('debt.homeBannerTitle') : t('debt.homePendingTitle');
  const action = isDebt ? t('debt.homeBannerAction') : t('debt.homePendingAction');
  const a11y = isDebt
    ? `${title} ${formatPEN(amountCents)}. ${action}`
    : `${title}. ${action}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      onPress={onPress}
      style={[
        styles.debtStrip,
        {
          backgroundColor: theme.colors.surface,
          borderColor: accentColor,
          borderRadius: theme.radii.md,
        },
      ]}
    >
      <View style={[styles.debtDot, { backgroundColor: accentColor }]} />
      <Text variant="subhead" numberOfLines={1} style={styles.debtLabel}>
        {title}
        {isDebt ? (
          <>
            {'  ·  '}
            <Text variant="bodyStrong" tabular>
              {formatPEN(amountCents)}
            </Text>
          </>
        ) : null}
      </Text>
      <Text variant="subhead" color="accent" numberOfLines={1}>
        {action}
      </Text>
    </Pressable>
  );
}

/* ─── Encabezado de sección con enlace "ver todas" ─── */

interface SectionHeaderProps {
  title: string;
  actionLabel: string;
  onAction: () => void;
}

function SectionHeader({ title, actionLabel, onAction }: SectionHeaderProps): React.JSX.Element {
  return (
    <View style={styles.sectionHeader}>
      <Text variant="subhead" color="inkMuted">
        {title}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel={actionLabel} onPress={onAction} hitSlop={8}>
        <Text variant="subhead" color="accent">
          {actionLabel}
        </Text>
      </Pressable>
    </View>
  );
}

/* ─────────────────────────── Cuerpo peek (idle) ─────────────────────────── */

interface IdleBodyProps {
  savedPlaces: SavedPlace[];
  recents: TripResource['destination'][];
  onSelect: (place: RoutePlace) => void;
  onSeeAllSaved: () => void;
  onSeeAllRecents: () => void;
}

/**
 * Cuerpo SCROLLABLE del peek: favoritos guardados + recientes, cada sección con "ver todas". Casa y
 * Trabajo NO van acá (son chips del header fijo); acá solo favoritos. El buscador vive en el header.
 */
function IdleBody({
  savedPlaces,
  recents,
  onSelect,
  onSeeAllSaved,
  onSeeAllRecents,
}: IdleBodyProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const favorites = savedPlaces.filter((p) => p.kind === 'FAVORITE');

  return (
    <>
      {favorites.length > 0 ? (
        <View style={{ gap: theme.spacing.sm }}>
          <SectionHeader title={t('home.savedTitle')} actionLabel={t('home.seeAll')} onAction={onSeeAllSaved} />
          <Card variant="filled" padding="sm">
            {favorites.map((place) => (
              <ListItem
                key={place.id}
                title={place.label}
                subtitle={place.subtitle}
                leading={<IconStar color={theme.colors.accent} size={20} />}
                chevron
                onPress={() => onSelect(placeToRoute(place))}
              />
            ))}
          </Card>
        </View>
      ) : null}

      {recents.length > 0 ? (
        <View style={{ gap: theme.spacing.sm }}>
          <SectionHeader
            title={t('home.shortcutRecent')}
            actionLabel={t('home.seeAll')}
            onAction={onSeeAllRecents}
          />
          <Card variant="outlined" padding="sm">
            {recents.map((point, index) => (
              <RecentRow key={`${point.lat}-${point.lon}-${index}`} point={point} onSelect={onSelect} />
            ))}
          </Card>
        </View>
      ) : null}
    </>
  );
}

interface RecentRowProps {
  point: TripResource['destination'];
  onSelect: (place: RoutePlace) => void;
}

/** Fila de destino reciente: etiqueta el punto con geocoding inverso real y, al tocar, lo fija. */
function RecentRow({ point, onSelect }: RecentRowProps): React.JSX.Element | null {
  const theme = useTheme();
  const reverseGeocode = useDependency(TOKENS.reverseGeocodeUseCase);
  const mapPoint = useMemo<MapPoint>(() => ({ lat: point.lat, lng: point.lon }), [point]);

  const labelQuery = useQuery({
    queryKey: ['maps', 'reverse', mapPoint.lat, mapPoint.lng],
    queryFn: () => reverseGeocode.execute(mapPoint),
    staleTime: 5 * 60_000,
  });

  if (!labelQuery.data) {
    return null;
  }

  return (
    <ListItem
      title={labelQuery.data.title}
      subtitle={labelQuery.data.subtitle}
      leading={<IconPin color={theme.colors.inkSubtle} size={18} />}
      onPress={() =>
        onSelect({
          point: { lat: labelQuery.data!.lat, lng: labelQuery.data!.lng },
          title: labelQuery.data!.title,
          subtitle: labelQuery.data!.subtitle,
        })
      }
    />
  );
}

/* ─────────────────────── Cuerpo búsqueda (searching) ─────────────────────── */

interface SearchingBodyProps {
  showCurrentLocation: boolean;
  currentLocationSubtitle?: string;
  onUseCurrentLocation: () => void;
  suggestions: PlaceSuggestion[];
  loading: boolean;
  error: boolean;
  active: boolean;
  onSelectSuggestion: (suggestion: PlaceSuggestion) => void;
  onSelectSaved: (place: SavedPlace) => void;
}

/**
 * Cuerpo SCROLLABLE del modo búsqueda (DENTRO del sheet): "usar mi ubicación", atajos de guardados y
 * sugerencias de autocompletado real. El input con autofocus + cerrar viven en el HEADER FIJO, así que
 * al scrollear las sugerencias el buscador NO se va de pantalla.
 */
function SearchingBody({
  showCurrentLocation,
  currentLocationSubtitle,
  onUseCurrentLocation,
  suggestions,
  loading,
  error,
  active,
  onSelectSuggestion,
  onSelectSaved,
}: SearchingBodyProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();

  return (
    <>
      {error ? <Banner tone="danger" title={t('maps.searchError')} /> : null}

      {showCurrentLocation ? (
        <ListItem
          title={t('maps.useCurrentLocation')}
          subtitle={currentLocationSubtitle}
          onPress={onUseCurrentLocation}
          leading={<IconTarget color={theme.colors.accent} size={20} />}
        />
      ) : null}

      {!active ? <SavedPlacesShortcuts onSelect={onSelectSaved} /> : null}

      {suggestions.length > 0
        ? suggestions.map((item, index) => (
            <EnterView key={item.id} index={index} offsetY={6}>
              <ListItem
                title={item.title}
                subtitle={item.subtitle}
                onPress={() => onSelectSuggestion(item)}
                leading={<IconPin color={theme.colors.inkSubtle} size={18} />}
              />
            </EnterView>
          ))
        : null}

      {suggestions.length === 0 && loading ? (
        <View style={{ gap: theme.spacing.md, paddingTop: theme.spacing.md }}>
          <Skeleton variant="text" height={20} />
          <Skeleton variant="text" height={20} />
          <Skeleton variant="text" height={20} />
        </View>
      ) : null}

      {suggestions.length === 0 && !loading ? (
        <Text variant="footnote" color="inkSubtle" align="center" style={{ paddingTop: theme.spacing.lg }}>
          {active ? t('maps.noResults') : t('maps.typeMore')}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // Capa del pin de recojo (modelo Cabify): centra el pin en el centro GEOMÉTRICO del mapa — que es lo que
  // reporta onCenterChange — sobre el mapa y bajo el chrome. No intercepta gestos (pointerEvents none).
  pickupPinLayer: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  topRow: {
    position: 'absolute',
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  locationPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
  },
  locationDot: { width: 7, height: 7, borderRadius: 999 },
  locationLabel: { flexShrink: 1 },
  locationAction: { fontWeight: '600', flexShrink: 0 },
  sheetScroll: { flex: 1 },
  sheetContent: { paddingTop: 4 },
  // Header FIJO del sheet (no scrollea): buscador + chips Casa/Trabajo.
  header: { paddingBottom: 8 },
  chipsRow: { flexDirection: 'row', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderWidth: 1,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  // Franja pasiva de deuda: borde warn sobrio, punto + label + acción. Sin fondo alarmante (no castiga).
  debtStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
  },
  debtDot: { width: 7, height: 7, borderRadius: 999 },
  debtLabel: { flex: 1 },
  // Header del modo búsqueda (input + cerrar), también fijo.
  searchHeader: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  searchInput: { flex: 1 },
  // Chrome flotante del viaje activo sobre el mapa.
  tripSos: { position: 'absolute' },
  tripChat: { position: 'absolute' },
  tripPill: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  tripBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
