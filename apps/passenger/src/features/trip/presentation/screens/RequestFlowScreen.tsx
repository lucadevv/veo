import type { GeoPoint, MapPoint, OfferView, TripResource } from '@veo/api-client';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RoutePin, useTheme } from '@veo/ui-kit';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
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
import { useSavedPlacesStore } from '../../../places/presentation/stores/savedPlacesStore';
import { DebtSheet } from '../../../payments/presentation';
import { usePushPermission } from '../../../notifications/presentation/hooks/usePushPermission';
import { PushPrePrompt } from '../../../notifications/presentation/components/PushPrePrompt';
import { usePanicAutoTrigger } from '../../../panic/presentation';
import { HomeTopBar } from '../components/HomeTopBar';
import { TripTopBar } from '../components/TripTopBar';
import { useCurrentLocation } from '../hooks/useCurrentLocation';
import { usePassengerTripSocket } from '../hooks/usePassengerTripSocket';
import { useWaypointProposal } from '../hooks/useWaypointProposal';
import { useOfferBoard } from '../hooks/useOfferBoard';
import { useHydrateActiveTrip } from '../hooks/useHydrateActiveTrip';
import { useDebtGate } from '../hooks/useDebtGate';
import { usePickupPin } from '../hooks/usePickupPin';
import { useRecentDestinations } from '../hooks/useRecentDestinations';
import { resolveTripPhase, mapModeForPhase, isLiveSocketPhase } from '../hooks/tripFlowPhase';
import {
  resolvePickupMode,
  TRIP_PHASE_DESCRIPTORS,
  type RequestFlowContext,
  type SheetFlowState,
} from '../hooks/tripPhaseDescriptors';
import { resolveMapDirective } from '../hooks/mapDirector';
import { useActiveTripStore } from '../stores/activeTripStore';

/** Convierte el punto del borrador (MapPoint, lng) al GeoPoint (lon) que consume el AppMap. */
function draftToGeo(place: { point: MapPoint } | null): GeoPoint | null {
  return place ? { lat: place.point.lat, lon: place.point.lng } : null;
}

type Nav = NativeStackNavigationProp<RootStackParamList>;

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

/**
 * Pantalla del tab "Pedir viaje" — el CONTENEDOR del flujo unificado. El mapa es PERSISTENTE de fondo y
 * sobre él flota un `DraggableSheet` ADAPTATIVO. Qué muestra el sheet en cada fase NO se decide acá: lo
 * declara `TRIP_PHASE_DESCRIPTORS` (patrón State, exhaustivo por fase); esta pantalla orquesta los hooks,
 * arma el `RequestFlowContext` y renderiza los slots (Body/Header) del descriptor.
 *
 *  - `idle` (peek/expandido): atajos de 1 toque (chips Casa/Trabajo, guardados, recientes) → fijan
 *    destino y la fase pasa a `quoting` EN EL MISMO sheet.
 *  - flow `searching`: tocar el buscador EXPANDE el MISMO sheet y pliega la búsqueda adentro (input con
 *    autofocus + "usar mi ubicación" + sugerencias). No se navega a otra pantalla para buscar.
 */
export function RequestFlowScreen(): React.JSX.Element {
  const theme = useTheme();
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
  // Eje LOCAL del sheet (idle ↔ searching, la 2ª máquina) + texto de búsqueda. flowRef evita closures
  // rancios en handleSnap.
  const [flow, setFlow] = useState<SheetFlowState>('idle');
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const [query, setQuery] = useState('');
  // Geometría de la ruta del quote (la reporta QuotingBody) para que el AppMap persistente la dibuje.
  const [routeCoords, setRouteCoords] = useState<[number, number][]>([]);
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
  // solo, vía el efecto de `descriptor.expanded` (completed→idle apaga el full). Es el ÚNICO punto de reset.
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

  // FASE del flujo (máquina central, única fuente de verdad) + su DESCRIPTOR (patrón State): qué body y
  // header muestra el sheet, y los rasgos de la fase (ambiente, snap, deuda, pánico…) salen de UN lugar.
  const phase = resolveTripPhase({
    hasDestination: Boolean(destination),
    activeTripId,
    status: board.status,
    offerCount: board.offers.length,
  });
  const descriptor = TRIP_PHASE_DESCRIPTORS[phase];

  // Gatea el socket por FASE: solo lo abrimos en fases vivas (puja + viaje activo). En `completed`/cierre
  // o `idle`/`quoting` lo cerramos. La fase se deriva del poll REST de estado cuando el socket está apagado,
  // por eso este lazo converge (apagado → REST dice COMPLETED → fase completed → sigue apagado). El socket
  // arranca un render DESPUÉS de entrar a una fase viva (latencia despreciable: el REST ya alimenta la UI).
  useEffect(() => {
    setSocketEnabled(isLiveSocketPhase(phase));
  }, [phase]);

  // AMBIENTE: autitos cercanos anónimos alrededor del pasajero (fases con `showNearby` en el descriptor).
  // Centro = la ubicación del usuario. El hook ya degrada a lista vacía en error (es decoración del mapa).
  const { vehicles: nearbyVehicles } = useNearbyVehicles(myLocation, descriptor.showNearby);

  // Detalle del viaje (conductor/vehículo/tarifa) para el cuerpo del viaje activo Y el cierre (pago/rating).
  const tripDetailQuery = useQuery({
    queryKey: ['trip', activeTripId, 'active'],
    queryFn: () => tripRepository.getActiveTrip(activeTripId as string),
    enabled: Boolean(activeTripId) && descriptor.needsTripDetail,
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
  usePanicAutoTrigger(activeTripId ?? '', descriptor.activeTrip);

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

  // MODELO CABIFY · recojo con PIN en el Home: las DOS máquinas (fase × flow del sheet) se componen en el
  // descriptor (`resolvePickupMode`); el hook posee el seguimiento centro→reverse-geocode→origen.
  const pickupMode = resolvePickupMode(phase, flow);
  const pickup = usePickupPin(pickupMode, myLocation);

  // RECIENTES desde el BACKEND REAL con fallback al snapshot local (degradación honesta).
  const recents = useRecentDestinations();

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

  const onOpenCamera = useCallback(
    () => navigation.navigate('CameraLive', { tripId: activeTripId as string }),
    [navigation, activeTripId],
  );

  // DEUDA (BR-P02) · el gate encapsulado: franja pasiva del home + DebtSheet con sus dos orígenes
  // (pedido bloqueado 403 / franja) + re-intento del pedido tras saldar. Consulta SOLO en el home idle.
  const debtGate = useDebtGate(descriptor.pollsDebts);

  // Snap por fase: lo declara el descriptor (`expanded`: cotización y cierre a full; el resto, peek
  // content-hug — el sheet ABRAZA su contenido y el mapa SIEMPRE queda visible arriba).
  const expandedPhase = descriptor.expanded;
  useEffect(() => {
    sheetRef.current?.snapToIndex(expandedPhase ? FULL_INDEX : PEEK_INDEX);
  }, [expandedPhase]);

  // PUENTE INTERINO (Lote 4 pendiente): SOLO la reasignación AÚN navega a su pantalla y resetea el
  // screen a idle; CANCELLED/FAILED (ended) limpian y vuelven al home. Las demás fases viven en el sheet
  // (el flujo es UNO). La salida de cada fase la declara el descriptor (`handoff`).
  const handedOff = useRef(false);
  useEffect(() => {
    if (!activeTripId) {
      handedOff.current = false;
      return;
    }
    if (handedOff.current) return;
    const id = activeTripId;
    if (descriptor.handoff === 'reassign') {
      handedOff.current = true;
      navigation.navigate('Reassign', { tripId: id });
      clearTrip();
    } else if (descriptor.handoff === 'clear') {
      handedOff.current = true;
      clearTrip();
    }
  }, [descriptor.handoff, activeTripId, navigation, clearTrip]);

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

  // Encuadre del mapa memoizado (mismo objeto para route y trip mode): un literal inline se recreaba en
  // cada render y rompía el React.memo del AppMap. Solo cambia con el safe-area top o el alto del peek.
  const fitEdgePadding = useMemo(
    () => ({ top: insets.top + 40, bottom: peekHeight + 16, left: 40, right: 40 }),
    [insets.top, peekHeight],
  );

  // CONTEXTO para los slots del descriptor (Body/Header): el wiring del contenedor, explícito y en UN
  // solo lugar. Cada fase toma de acá exactamente lo que su body/header necesita.
  const ctx: RequestFlowContext = {
    flow,
    activeTripId,
    board,
    live,
    tripDetail: tripDetailQuery.data ?? null,
    addStop,
    kycStatus: profileQuery.data?.kycStatus ?? null,
    requestAgainToken: debtGate.requestAgainToken,
    onTripCreated,
    onScheduled,
    onKycRequired,
    onDebtPending: debtGate.onDebtPending,
    onActiveTripExists: setActiveTripId,
    onRouteChange: setRouteCoords,
    onCancelQuoting: cancelQuoting,
    destinationTitle: destination?.title ?? null,
    onChooseOffer,
    onOpenCamera,
    clearTrip,
    hasDebt: debtGate.hasDebt,
    debtTotalCents: debtGate.debtTotalCents,
    hasPendingAction: debtGate.hasPendingAction,
    onOpenDebtFromHome: debtGate.openDebtFromHome,
    onOpenPendingFromHome: debtGate.openPendingFromHome,
    savedPlaces,
    recents,
    onSelectDestination: selectDestination,
    onSeeAllSaved: goSavedPlaces,
    onSeeAllRecents: goTripHistory,
    onEnterSearch: enterSearch,
    query,
    onQueryChange: setQuery,
    onExitSearch: exitSearch,
    hasCurrentLocation: Boolean(reverseQuery.data),
    currentLocationSubtitle: reverseQuery.data?.subtitle,
    onUseCurrentLocation: useCurrentAsDestination,
    suggestions,
    searchLoading,
    searchError,
    searchActive: active,
  };

  const SheetBody = descriptor.Body;
  const SheetHeader = descriptor.Header;

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
            nearbyVehicles={descriptor.showNearby ? nearbyVehicles : undefined}
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
            // SÍ ayuda (lo declara el descriptor). El director decide el encuadre; los markers de
            // origen/destino se mantienen para contexto de la ruta (el destino siempre).
            origin={descriptor.tripMapShowsOrigin ? originGeo : null}
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
            fitToRoute={mapDirective.cameraTarget == null && descriptor.activeTrip}
            fitEdgePadding={fitEdgePadding}
            // El encuadre lo gobierna el cameraTarget (director) cuando dirige; si no, el fit declarativo.
            // El AppMap TOPA el bottomInset al CAP para el fit dirigido (enRoute conductor+recogida).
            bottomInset={peekHeight + 16}
            interactive
          />
        ) : (
          <AppMap
            center={pickup.initialCenter ?? myLocation}
            onCenterChange={pickupMode ? pickup.onCenterChange : undefined}
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

      {/* Chrome superior sobre el mapa: el del HOME (pill de ubicación + campana + avatar) u, durante el
          viaje activo, el del VIAJE (SOS + pill "EN VIVO" + chat con badge). */}
      {!descriptor.activeTrip ? (
        <HomeTopBar
          locationStatus={locationStatus}
          onRetryLocation={retryLocation}
          originTitle={origin?.title ?? null}
          reverseTitle={reverseQuery.data?.title ?? null}
          profileName={profileQuery.data?.name ?? null}
          profilePhotoUrl={profileQuery.data?.photoUrl ?? null}
          onOpenNotifications={() => navigation.navigate('Notifications')}
          onOpenProfile={() => navigation.navigate('Main', { screen: 'Profile' })}
        />
      ) : (
        <TripTopBar
          unreadCount={unreadCount}
          onOpenChat={openChat}
          onSos={() => navigation.navigate('Panic', { tripId: activeTripId as string })}
        />
      )}

      {/* BOTTOMSHEET ARRASTRABLE anclado abajo. HEADER FIJO y BODY SCROLLABLE: ambos los declara el
          descriptor de la fase (Header null = la fase trae su cuerpo autocontenido, sin chrome del home). */}
      <DraggableSheet
        ref={sheetRef}
        snapPoints={SNAP_POINTS}
        maxContentFraction={PEEK_MAX_FRACTION}
        onSnap={handleSnap}
        onPeekHeightChange={setPeekHeight}
        bottomOffset={tabBarHeight}
        renderHeader={() => (SheetHeader ? <SheetHeader ctx={ctx} /> : null)}
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
            <SheetBody ctx={ctx} />
          </ScrollComponent>
        )}
      />

      {/* DEUDA (BR-P02): un único sheet para los dos orígenes (pedido bloqueado 403 / franja del home).
          Saldar → CAPTURED reabre el camino: si vino de un pedido, re-intentamos solo (requestAgainToken). */}
      <DebtSheet
        visible={debtGate.debtSheetOpen}
        debt={debtGate.debtView}
        pendingActionPaymentId={debtGate.pendingActionPaymentId}
        onClose={debtGate.closeDebtSheet}
        onSettled={debtGate.onDebtSettled}
      />

      {/* Pre-prompt CONTEXTUAL de notificaciones: al estar BUSCANDO conductor (ahí el push importa) y solo
          si el permiso nunca se decidió ('undetermined'). Una vez por sesión; "Ahora no" no insiste. */}
      <PushPrePrompt
        visible={descriptor.showsPushPrePrompt && push.status === 'undetermined' && !pushPrePromptSeen}
        onDismiss={() => setPushPrePromptSeen(true)}
        onEnable={() => {
          setPushPrePromptSeen(true);
          void push.enable();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // Capa del pin de recojo (modelo Cabify): centra el pin en el centro GEOMÉTRICO del mapa — que es lo que
  // reporta onCenterChange — sobre el mapa y bajo el chrome. No intercepta gestos (pointerEvents none).
  pickupPinLayer: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  sheetScroll: { flex: 1 },
  sheetContent: { paddingTop: 4 },
});
