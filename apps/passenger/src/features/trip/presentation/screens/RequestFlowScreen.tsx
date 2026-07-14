import type {
  GeoPoint,
  MapPoint,
  OfferView,
  TripResource,
} from '@veo/api-client';
import {useIsFocused, useNavigation} from '@react-navigation/native';
import type {BottomTabNavigationProp} from '@react-navigation/bottom-tabs';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import {RoutePin, useTheme} from '@veo/ui-kit';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Image,
  Keyboard,
  Platform,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import type {
  MainTabsParamList,
  RootStackParamList,
} from '../../../../navigation/types';
import {AppMap} from '../../../../shared/presentation/components/AppMap';
import {decodePolylineToCoordinates} from '../../../../shared/utils/polyline';
// Renombrado de home-map.jpg: Metro cacheaba el asset VIEJO por hash (el sim mostraba solo nubes,
// sin la ruta azul de la imagen real) — nombre nuevo = URL nueva = caché bypasseada.
import homeMapBackdrop from '../../../../shared/assets/brand/home-map-light.jpg';
import {
  DraggableSheet,
  type DraggableSheetHandle,
  type SnapPoint,
} from '@veo/ui-kit';
import {isWaypointSet, type RoutePlace} from '../../../maps/domain/entities';
import {useNearbyVehicles} from '../../../../core/query/useNearbyVehicles';
import {useAutocomplete} from '../../../../shared/presentation/hooks/useAutocomplete';
import {useRideDraftStore} from '../../../maps/presentation/stores/rideDraftStore';
import {useSavedPlacesStore} from '../../../places/presentation/stores/savedPlacesStore';
import {DebtSheet} from '../../../payments/presentation';
import {usePushPermission} from '../../../../core/notifications/usePushPermission';
import {PushPrePrompt} from '../../../notifications/presentation/components/PushPrePrompt';
import {usePanicAutoTrigger} from '../../../../core/panic/usePanicAutoTrigger';
import {HomeTopBar} from '../components/HomeTopBar';
import {TripTopBar} from '../components/TripTopBar';
import {useCurrentLocation} from '../../../../core/location/useCurrentLocation';
import {usePassengerTripSocket} from '../../../../core/realtime/usePassengerTripSocket';
import {useWaypointProposal} from '../hooks/useWaypointProposal';
import {useOfferBoard} from '../hooks/useOfferBoard';
import {useHydrateActiveTrip} from '../hooks/useHydrateActiveTrip';
import {useDebtGate} from '../hooks/useDebtGate';
import {useLastDriver} from '../hooks/useLastDriver';
import {
  resolveTripPhase,
  mapModeForPhase,
  isLiveSocketPhase,
} from '../hooks/tripFlowPhase';
import {
  resolvePickupMode,
  TRIP_PHASE_DESCRIPTORS,
  type RequestFlowContext,
  type SheetFlowState,
} from '../hooks/tripPhaseDescriptors';
import {resolveMapDirective} from '../hooks/mapDirector';
import {useActiveTripStore} from '../stores/activeTripStore';

/** Convierte el punto del borrador (MapPoint, lng) al GeoPoint (lon) que consume el AppMap. */
function draftToGeo(place: {point: MapPoint} | null): GeoPoint | null {
  return place ? {lat: place.point.lat, lon: place.point.lng} : null;
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
const SNAP_POINTS = ['content', {content: 0.94}] as const;
const PEEK_MAX_FRACTION = 0.5;
const PEEK_INDEX = 0;
const FULL_INDEX = SNAP_POINTS.length - 1;
/** Alto de la TabBar flotante (pill + margen) para que el sheet del Home idle NO quede debajo. */
const HOME_TABBAR_CLEARANCE = 88;
/**
 * Dónde ARRANCA la hoja del Home idle, como fracción de la pantalla (pen P/Home: HomeContent en
 * y=190 de 844). Fija la "ventana" de imagen visible arriba en ~22.5%: más abajo la imagen se
 * derrama y el backdrop se siente gigante/zoomeado (la queja que motivó este layout).
 */
const HOME_SHEET_TOP_FRACTION = 190 / 844;
/**
 * Anclaje COLAPSADO del Home (fracción del área útil visible): arrastrando la hoja hacia abajo
 * queda lo esencial (hero + buscador) y respira la imagen de fondo. Pedido del dueño: "el tope
 * inferior más abajo" — antes ambos anclajes vivían arriba (0.88/0.92) y colapsar no existía.
 */
const HOME_SHEET_COLLAPSED_FRACTION = 0.45;
/**
 * Dimensiones REALES del arte del backdrop (home-map-light.jpg · aérea de día 1200×1800, Theme de
 * Confianza light). Alto = pantalla, ancho = alto × aspect, centrado horizontal — sin cover ni zoom
 * del layout (el aspect ya respeta la proporción, así que `stretch` no deforma).
 */
const HOME_BACKDROP_ASPECT = 1200 / 1800;

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
  // TEARDOWN del contexto GL del mapa (CRÍTICO, sin tabs): el Home es la pantalla RAÍZ del stack y al
  // pushear otra encima (Profile/Search/Notifications/Chat/...) NO se desmonta — quedaría montado con su
  // `MapView` (@rnmapbox/maps) reteniendo el contexto GL/Metal nativo, que solo se libera en el `deinit`
  // de la vista al DESMONTARSE. Antes, el tab navigator con `detachInactiveScreens` desmontaba el Home al
  // cambiar de tab y cortaba el leak; al quitar los tabs hay que replicar ESE desmontaje. `useIsFocused`
  // es false cuando el Home pierde foco (otra pantalla arriba) → abajo renderizamos el `AppMap` SOLO si
  // `isFocused`, de modo que al perder foco el mapa se desmonta (libera el contexto) y al volver remonta.
  // Sin esto: tras N navegaciones/reloads se acumulan contextos GL huérfanos → mapa negro.
  const isFocused = useIsFocused();
  const {height: windowHeight, width: windowWidth} = useWindowDimensions();
  // Vista TIPADA del MISMO navigator más cercano (el tab navigator de MainTabs) para setear
  // opciones de la TabBar; `navigation` (Nav) queda para los push del stack padre.
  const tabNavigation =
    useNavigation<BottomTabNavigationProp<MainTabsParamList>>();
  // Sin tab bar, el sheet ancla contra el inset inferior del safe-area (home indicator), no contra el
  // alto del tab bar (que ya no existe). Mantiene la matemática de fracciones del sheet correcta.
  const bottomInset = insets.bottom;

  const reverseGeocode = useDependency(TOKENS.reverseGeocodeUseCase);
  const getProfile = useDependency(TOKENS.getProfileUseCase);
  const history = useDependency(TOKENS.tripHistoryRepository);
  const tripRepository = useDependency(TOKENS.tripRepository);

  const {
    point: myLocation,
    status: locationStatus,
    retry: retryLocation,
  } = useCurrentLocation();
  const origin = useRideDraftStore(s => s.origin);
  const destination = useRideDraftStore(s => s.destination);
  const waypoints = useRideDraftStore(s => s.waypoints);
  const setOrigin = useRideDraftStore(s => s.setOrigin);
  const setDestination = useRideDraftStore(s => s.setDestination);
  const setEditing = useRideDraftStore(s => s.setEditing);
  const swapRoute = useRideDraftStore(s => s.swap);
  const resetDraft = useRideDraftStore(s => s.reset);
  const savedPlaces = useSavedPlacesStore(s => s.places);

  // Alto visible del peek (lo reporta el sheet): se lo pasamos al mapa como paddingBottom para que el
  // pin del usuario quede en la franja visible por encima del sheet, no tapado por él.
  const [peekHeight, setPeekHeight] = useState(0);
  // Alto visible del snap ACTUAL del sheet (expandir/contraer/colapsar): la cámara del mapa RE-ENCUADRA
  // su foco al área visible real en cada asentamiento (regla: el foco vive en viewport − sheet, no en la
  // pantalla completa). El AppMap CAPA este valor por modo de cámara (fit 32% / center 50%) para que un
  // sheet casi-full no aplaste el viewport. 0 = aún sin primer reporte → cae al peek.
  const [sheetVisibleHeight, setSheetVisibleHeight] = useState(0);
  // Inset que el mapa reserva para el sheet: el snap actual si ya se reportó; si no, el peek.
  const sheetMapInset = sheetVisibleHeight > 0 ? sheetVisibleHeight : peekHeight;
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
  const activeTripId = useActiveTripStore(s => s.activeTripId);
  const activeTripMode = useActiveTripStore(s => s.activeTripMode);
  const activeTripVehicleType = useActiveTripStore(s => s.activeTripVehicleType);
  const setActiveTripId = useActiveTripStore(s => s.setActiveTripId);
  const setActiveTripMode = useActiveTripStore(s => s.setActiveTripMode);
  const setActiveTripVehicleType = useActiveTripStore(
    s => s.setActiveTripVehicleType,
  );
  const clearActiveTrip = useActiveTripStore(s => s.clear);

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
    mode: activeTripMode,
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
  const {vehicles: nearbyVehicles} = useNearbyVehicles(
    myLocation,
    descriptor.showNearby,
  );

  // Detalle del viaje (conductor/vehículo/tarifa) para el cuerpo del viaje activo Y el cierre (pago/rating).
  // El poll se corta por FASE terminal (completed/ended), no por `live.ended`: en el cierre el socket está
  // APAGADO (isLiveSocketPhase) → `live.ended` jamás llega a true y el detalle quedaba refetcheando cada
  // 15 s PARA SIEMPRE en la pantalla del recibo. El detalle de un viaje terminal ya no cambia.
  const terminalPhase = phase === 'completed' || phase === 'ended';
  const tripDetailQuery = useQuery({
    queryKey: ['trip', activeTripId, 'active'],
    queryFn: () => tripRepository.getActiveTrip(activeTripId as string),
    enabled: Boolean(activeTripId) && descriptor.needsTripDetail,
    refetchInterval: terminalPhase || live.ended ? false : 15_000,
  });

  // RUTA POR FASE del viaje activo (GET /trips/:id/route — el ESPEJO del conductor, mismo contrato):
  // pre-recojo el server traza conductor→recojo→destino desde la última ubicación del conductor
  // (el pasajero VE por dónde viene el taxi); onboard, conductor→destino. Reemplaza a la polyline
  // CONGELADA del quote en las fases del viaje. La FASE entra en la queryKey → al pasar de
  // approach→onboard se re-pide YA (sin esperar el poll), simétrico a la invalidación del conductor.
  const isRoutePhase =
    phase === 'enRoute' || phase === 'arrived' || phase === 'inProgress';
  const routeLeg = phase === 'inProgress' ? 'onboard' : 'approach';
  const tripRouteQuery = useQuery({
    queryKey: ['trip', activeTripId, 'route', routeLeg],
    queryFn: () => tripRepository.getTripRoute(activeTripId as string),
    enabled: Boolean(activeTripId) && isRoutePhase,
    refetchInterval: isRoutePhase ? 15_000 : false,
    staleTime: 15_000,
  });
  const liveRouteCoords = useMemo(
    () =>
      tripRouteQuery.data
        ? decodePolylineToCoordinates(tripRouteQuery.data.polyline)
        : null,
    [tripRouteQuery.data],
  );

  // PARADA negociada mid-trip (Lote C3): el pasajero propone una parada durante el viaje EN CURSO. El
  // hook posee el picking (el tap del mapa → `addStop.pickPoint`), el POST y la máquina de la propuesta.
  // El OUTCOME en vivo (aceptó/rechazó/venció) llega por el socket `/passenger` (Lote C4); el hook lo
  // consume para cerrar el "esperando". Si el socket está caído, el vencimiento local sigue resolviendo.
  const queryClient = useQueryClient();
  const addStop = useWaypointProposal(activeTripId ?? '', live.waypointOutcome);

  // Reintento del detalle del viaje (pago/cierre): sin esto, un fallo del fetch dejaba el body en Skeleton
  // infinito. `refetch` de react-query es referencialmente estable, así que el callback no cambia por render.
  const retryTripDetail = useCallback(() => {
    void tripDetailQuery.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Al ACEPTARSE la parada, el viaje cambió server-side (ruta + paradas + tarifa): refrescamos el detalle
  // para que el mapa y la tarifa reflejen lo nuevo sin esperar al poll de 15 s.
  useEffect(() => {
    if (addStop.phase === 'accepted' && activeTripId) {
      void queryClient.invalidateQueries({
        queryKey: ['trip', activeTripId, 'active'],
      });
      // La parada aceptada CAMBIÓ la geometría del viaje: la ruta viva se re-pide YA (todas las fases).
      void queryClient.invalidateQueries({
        queryKey: ['trip', activeTripId, 'route'],
      });
    }
  }, [addStop.phase, activeTripId, queryClient]);

  // COREOGRAFÍA DEL MAPA POR FASE (helper puro). Decide qué markers muestra y cómo encuadra la cámara
  // (fit conductor+recogida / follow "como si manejara" / center). El AppMap solo recibe props simples
  // (showUserPoint, cameraTarget, …). El vehicleType REAL del viaje vive en el activeTripStore (congelado
  // al crear; TripActiveView no lo trae) → sin dato, CAR (decisión del dueño: "si no hay tipo, CAR").
  // Memoizado por las coords que driftean para no reconstruir el target en cada render del padre.
  // Memoizados por el RoutePlace del store (referencia estable salvo que cambien). Se pasan al AppMap
  // (React.memo): sin memo, un objeto nuevo por render rompía el memo y empujaba props nuevas al GL thread
  // del mapa en cada keystroke del buscador / cambio de peekHeight. Un solo origen para route y trip mode.
  const originGeo = useMemo(() => draftToGeo(origin), [origin]);
  const destinationGeo = useMemo(() => draftToGeo(destination), [destination]);
  // Paradas intermedias (Ola 2B) para pintarlas en el MAPA del flujo principal.
  // Filtramos los placeholders vacíos y convertimos lng→lon.
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
  const driverVehicleType = activeTripVehicleType ?? 'CAR';
  const mapDirective = useMemo(
    () =>
      resolveMapDirective({
        phase,
        driver: live.driverLocation ?? null,
        // Rumbo del socket para el follow course-up del viaje en curso. Va en deps: llega junto con la
        // coord en el mismo mensaje, así el target siempre carga la muestra fresca.
        driverHeading: live.driverHeading,
        origin: originGeo,
        destination: destinationGeo,
        userPoint: myLocation,
        vehicleType: driverVehicleType,
        hasRoute: routeCoords.length > 1,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      phase,
      live.driverLocation?.lat,
      live.driverLocation?.lon,
      live.driverHeading,
      originGeo?.lat,
      originGeo?.lon,
      destinationGeo?.lat,
      destinationGeo?.lon,
      myLocation?.lat,
      myLocation?.lon,
      driverVehicleType,
      routeCoords.length,
    ],
  );

  // Pánico nativo (triple volumen): armado SOLO durante el viaje activo (se desarma fuera).
  usePanicAutoTrigger(activeTripId ?? '', descriptor.activeTrip);

  // Chat con el conductor: drena los no leídos y abre la pantalla de chat.
  const unreadCount = live.incomingMessages.length;
  const openChat = useCallback(() => {
    live.acknowledgeMessages(live.incomingMessages.map(m => m.id));
    // El primer nombre del conductor para el título del chat (simétrico al conductor, que muestra el del
    // pasajero). `undefined` si aún no se resolvió → el chat cae al título genérico.
    const driverName = tripDetailQuery.data?.driver?.name?.trim().split(/\s+/)[0];
    navigation.navigate('Chat', {
      tripId: activeTripId as string,
      driverName: driverName || undefined,
    });
  }, [live, navigation, activeTripId, tripDetailQuery.data]);

  // Compartir con la familia: pantalla dedicada (pen zKyic) — mismo patrón que openChat. La acción
  // "Compartir" del sheet ya no dispara el Share nativo directo.
  const openFamilyShare = useCallback(() => {
    navigation.navigate('FamilyShare', {tripId: activeTripId as string});
  }, [navigation, activeTripId]);

  const myPoint = useMemo<MapPoint | null>(
    () => (myLocation ? {lat: myLocation.lat, lng: myLocation.lon} : null),
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
        point: {lat: reverseQuery.data.lat, lng: reverseQuery.data.lng},
        title: reverseQuery.data.title,
        subtitle: reverseQuery.data.subtitle,
      });
    }
  }, [origin, reverseQuery.data, setOrigin]);

  // Modo del mapa por fase (única evaluación): idle → SIN mapa (content-first, fondo sólido);
  // route/trip → mapa persistente de fondo. Se computa una vez y gobierna tanto el render del mapa como
  // el del contenido idle full-screen vs el bottom-sheet.
  const mapMode = mapModeForPhase(phase);

  // TABBAR por fase: fuera de idle (cotización/puja/viaje) la píldora flotante se ESCONDE — el pen
  // no la dibuja en esas fases (estás en un flujo, no navegando tabs) y tapaba el CTA del sheet
  // ("Confirmar VEO" bajo la TabBar). AppTabBar honra `tabBarStyle {display:'none'}` del descriptor.
  useEffect(() => {
    tabNavigation.setOptions({
      tabBarStyle: mapMode === 'idle' ? undefined : {display: 'none'},
    });
  }, [tabNavigation, mapMode]);

  // FONDO del Home por flow (pedido del dueño): en idle manda la IMAGEN 3D; al entrar a BÚSQUEDA
  // el fondo CRUZA SUAVE al mapa REAL de Mapbox centrado en mi ubicación, y al salir vuelve a la
  // imagen. Mecánica: el mapa se monta DEBAJO y la imagen (encima) anima su opacidad 1→0 — el
  // crossfade es un solo valor. El mapa se desmonta recién al TERMINAR el fade de vuelta (libera
  // el contexto GL sin flash).
  const searchBg = useSharedValue(0);
  const [searchMapMounted, setSearchMapMounted] = useState(false);
  useEffect(() => {
    if (mapMode !== 'idle') {
      return;
    }
    if (flow === 'searching') {
      setSearchMapMounted(true);
      searchBg.value = withTiming(1, {duration: 450});
    } else {
      searchBg.value = withTiming(0, {duration: 450}, finished => {
        if (finished) {
          runOnJS(setSearchMapMounted)(false);
        }
      });
    }
  }, [flow, mapMode, searchBg]);
  const idleImageStyle = useAnimatedStyle(() => ({
    opacity: 1 - searchBg.value,
  }));

  // MODELO CABIFY · recojo con PIN: el descriptor declara la elegibilidad por fase+flow (`resolvePickupMode`),
  // PERO el pin solo tiene sentido CON un mapa interactivo de fondo (arrastrás el mapa y el origen sigue al
  // centro). En el home CONTENT-FIRST ya NO hay mapa idle (única fase elegible), así que el pin nunca aplica:
  // el origen se siembra con la ubicación etiquetada (reverseQuery), sin pin que arrastrar. Si en el futuro
  // alguna fase con mapa habilita el pickup, gatearlo acá con `mapMode !== 'idle'`.
  const pickupMode = resolvePickupMode(phase, flow) && mapMode !== 'idle';

  // ÚLTIMO conductor para la tarjeta de confianza del Home idle. `null` si no hay viaje con conductor
  // (degradación honesta: la tarjeta no se renderiza, no se inventa un conductor).
  const {driver: lastDriver} = useLastDriver();

  // Autocompletado real (debounce + sesgo por ubicación), activo solo cuando hay texto.
  const {
    suggestions,
    loading: searchLoading,
    error: searchError,
    active,
  } = useAutocomplete(query, myPoint);

  // Tocar el buscador EXPANDE el sheet y entra a modo búsqueda DENTRO del mismo sheet (no navega).
  const enterSearch = useCallback(() => {
    setEditing({kind: 'destination'});
    setQuery('');
    setFlow('searching');
    sheetRef.current?.snapToIndex(FULL_INDEX);
  }, [setEditing]);

  // Elegir el DESTINO arrastrando el mapa (pen P/Home: ícono mapa del buscador): marca el destino
  // en edición y abre MapPick — el pin fijo al centro fija el punto (mismo mecanismo que usa la
  // búsqueda por texto con su fila "Elegir en el mapa").
  const pickOnMap = useCallback(() => {
    setEditing({kind: 'destination'});
    navigation.navigate('MapPick');
  }, [setEditing, navigation]);

  // Editar el ORIGEN desde el Home idle: marca el origen en edición y abre la búsqueda DEDICADA
  // (`Search`, flow 'sheet' → al fijar vuelve acá con el borrador actualizado). Es el MISMO gesto que
  // usa la cotización (`QuotingBody.editOrigin`): el origen deja de ser un display de solo lectura.
  const editOrigin = useCallback(() => {
    setEditing({kind: 'origin'});
    navigation.navigate('Search', {flow: 'sheet'});
  }, [setEditing, navigation]);

  // Sale de búsqueda (solo la X): limpia el flow/texto. El snap al reposo NO va acá — al cambiar
  // el flow cambian los ANCLAJES (búsqueda=1, idle=2) y snapear antes del re-render usaría el
  // array viejo (clamp al índice equivocado → caía al colapsado); lo maneja el efecto de abajo.
  const exitSearch = useCallback(() => {
    setFlow('idle');
    setQuery('');
  }, []);

  // Reposo tras cerrar la búsqueda: con los anclajes YA re-renderizados (idle = [colapsado, hoja]),
  // asienta la hoja en su posición del pen (índice 1).
  useEffect(() => {
    if (mapMode === 'idle' && flow === 'idle') {
      sheetRef.current?.snapToIndex(FULL_INDEX);
    }
  }, [mapMode, flow]);

  // El DRAG no entra NI sale de la búsqueda (entrar = tap en el buscador; salir = la X). Colapsar
  // el sheet BUSCANDO solo despeja la vista (cierra el teclado para ver el mapa con la ubicación);
  // la búsqueda sigue viva y el input queda arriba del sheet colapsado.
  const handleSnap = useCallback((index: number) => {
    if (flowRef.current === 'searching' && index <= PEEK_INDEX) {
      Keyboard.dismiss();
    }
  }, []);

  // KEYBOARD-AVOIDANCE del buscador in-sheet. El sheet es `position:absolute · bottom:0`, así que en iOS
  // (donde el teclado FLOTA sobre la ventana, sin redimensionarla) el teclado tapa la parte baja del sheet:
  // el input y las sugerencias quedaban ocultos detrás. Fix en DOS partes, SIN tocar el DraggableSheet
  // (que ya corre su drag/snap en el hilo de UI y no queremos pelear):
  //   1) el flow `searching` ancla el sheet a un alto FIJO (ver `sheetSnapPoints`), no content-hug → el
  //      header FIJO (origen + input) queda SIEMPRE arriba, sobre el teclado, aunque haya pocas sugerencias.
  //   2) acá medimos el alto del teclado y lo sumamos al `paddingBottom` del scroll → la lista scrollea
  //      por ENCIMA del teclado (la última sugerencia se alcanza). Android usa `adjustResize` (la ventana
  //      ya se achica sola), por eso solo compensamos en iOS.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') {
      return;
    }
    const show = Keyboard.addListener('keyboardWillShow', e =>
      setKeyboardHeight(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener('keyboardWillHide', () =>
      setKeyboardHeight(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
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
      // Modo congelado por el server → la fase EXPIRED distingue FIXED (sin conductor) de PUJA (sin ofertas).
      setActiveTripMode(trip.dispatchMode);
      // Tipo de vehículo solicitado (CAR | MOTO) → el marker del conductor asignado usa el glyph correcto
      // (la moto NO se pinta como auto). `TripActiveView` no lo trae; acá el POST /trips sí.
      setActiveTripVehicleType(trip.vehicleType);
    },
    [history, setActiveTripId, setActiveTripMode, setActiveTripVehicleType],
  );

  // Elegir una oferta del board: ACCEPT_PRICE → aceptar (match); COUNTER → contraoferta (INTERINO Lote 3).
  const onChooseOffer = useCallback(
    (offer: OfferView) => {
      if (board.acceptMutation.isPending) return;
      if (offer.kind === 'COUNTER') {
        navigation.navigate('Counter', {
          tripId: activeTripId as string,
          driverId: offer.driverId,
        });
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

  const onKycRequired = useCallback(
    () => navigation.navigate('KycCamera'),
    [navigation],
  );

  const onOpenCamera = useCallback(
    () => navigation.navigate('CameraLive', {tripId: activeTripId as string}),
    [navigation, activeTripId],
  );

  // DEUDA (BR-P02) · el gate encapsulado: franja pasiva del home + DebtSheet con sus dos orígenes
  // (pedido bloqueado 403 / franja) + re-intento del pedido tras saldar. Consulta SOLO en el home idle.
  const debtGate = useDebtGate(descriptor.pollsDebts);

  // Snap por fase: lo declara el descriptor (`expanded`: cotización y cierre a full; el resto, su
  // REPOSO). El reposo del Home idle es la HOJA del pen (índice 1) — el índice 0 es el anclaje
  // colapsado, al que solo se llega arrastrando. El VIAJE VIVO también reposa expandido (índice 1 =
  // content-hug de la tarjeta+tarifa+acciones): el índice 0 es la franja de estado sola, a la que solo
  // se llega arrastrando el grabber hacia abajo para maximizar el mapa (misma personalidad que el
  // conductor). En route/trip por peek content-hug quedó atrás.
  const expandedPhase = descriptor.expanded;
  const restingIndex =
    mapMode === 'idle' || descriptor.activeTrip ? FULL_INDEX : PEEK_INDEX;
  useEffect(() => {
    sheetRef.current?.snapToIndex(expandedPhase ? FULL_INDEX : restingIndex);
  }, [expandedPhase, restingIndex]);

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
      navigation.navigate('Reassign', {tripId: id});
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
        point: {lat: reverseQuery.data.lat, lng: reverseQuery.data.lng},
        title: reverseQuery.data.title,
        subtitle: reverseQuery.data.subtitle,
      });
    }
  }, [reverseQuery.data, selectDestination]);

  // "Ver todas" → pantallas de gestión existentes (lugares guardados / historial de viajes).
  const goSavedPlaces = useCallback(
    () => navigation.navigate('SavedPlaces'),
    [navigation],
  );
  const goTripHistory = useCallback(
    () => navigation.navigate('TripHistory'),
    [navigation],
  );

  // Encuadre del mapa memoizado (mismo objeto para route y trip mode): un literal inline se recreaba en
  // cada render y rompía el React.memo del AppMap. Cambia con el safe-area top (chrome superior) o el
  // alto del snap ACTUAL del sheet → el fit de ruta RE-ENCUADRA al asentarse el sheet en otro anclaje
  // (regla: la ruta vive en el área visible, no bajo el sheet). El AppMap topa el bottom con su CAP.
  const fitEdgePadding = useMemo(
    () => ({
      top: insets.top + 40,
      bottom: sheetMapInset + 16,
      left: 40,
      right: 40,
    }),
    [insets.top, sheetMapInset],
  );

  // Anclajes del sheet POR MODO. En idle Y en búsqueda: [COLAPSADO, HOJA-DEL-PEN] — la hoja se
  // arrastra en ambos flows (pedido del dueño). En BÚSQUEDA, colapsarla NO cierra la búsqueda
  // (eso se sentía como tocar la X sin querer): solo baja el sheet para ver el mapa con la
  // ubicación (y cierra el teclado — ver handleSnap); el único cierre es la X. En route/trip,
  // content-hug + full.
  const sheetSnapPoints = useMemo<ReadonlyArray<SnapPoint>>(() => {
    // VIAJE VIVO (enRoute/arrived/inProgress): colapsable a la SOLA franja de estado (snap 'header') → el
    // pasajero baja el grabber y el mapa queda al máximo; el reposo abraza el contenido (tarjeta del
    // conductor + tarifa + acciones) capado a la hoja del pen (0.94). Es el gesto del conductor, espejado.
    if (descriptor.activeTrip) {
      return ['header', {content: 0.94}];
    }
    if (mapMode !== 'idle') {
      return SNAP_POINTS;
    }
    const available = Math.max(windowHeight - insets.top - bottomInset, 1);
    const visible = windowHeight * (1 - HOME_SHEET_TOP_FRACTION);
    const sheetFraction = Math.min(visible / available, 0.94);
    // BÚSQUEDA: alto FIJO (no content-hug). Con content-hug, pocas sugerencias dejaban el sheet corto y
    // el input (header fijo) caía detrás del teclado; con alto fijo el sheet siempre es alto (la hoja del
    // .pen P/HomeSearch, con el mapa asomando arriba) → el input queda sobre el teclado y la lista
    // scrollea debajo. El resto de idle sigue en content-hug (abraza la hoja del Home).
    if (flow === 'searching') {
      return [HOME_SHEET_COLLAPSED_FRACTION, sheetFraction];
    }
    // Máximo CONTENT-HUG (crece al contenido) capado a la hoja del .pen: si el contenido es corto,
    // el sheet lo abraza; si es alto, se queda en la hoja del pen y scrollea adentro.
    return [HOME_SHEET_COLLAPSED_FRACTION, {content: sheetFraction}];
  }, [
    descriptor.activeTrip,
    mapMode,
    flow,
    windowHeight,
    insets.top,
    bottomInset,
  ]);

  // CONTEXTO para los slots del descriptor (Body/Header): el wiring del contenedor, explícito y en UN
  // solo lugar. Cada fase toma de acá exactamente lo que su body/header necesita.
  const ctx: RequestFlowContext = {
    flow,
    activeTripId,
    board,
    live,
    tripDetail: tripDetailQuery.data ?? null,
    // Solo es "error de detalle" cuando ESTA fase pide el detalle y aún no hay dato; si no, el body no lo mira.
    tripDetailError: tripDetailQuery.isError && !tripDetailQuery.data,
    onRetryTripDetail: retryTripDetail,
    addStop,
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
    onOpenChat: openChat,
    onOpenFamilyShare: openFamilyShare,
    unreadChatCount: unreadCount,
    clearTrip,
    // Reintentar FIJO sin conductor: limpia SOLO el viaje (store.clear) → conserva el borrador → 'quoting'.
    onRetryRequest: clearActiveTrip,
    hasDebt: debtGate.hasDebt,
    debtTotalCents: debtGate.debtTotalCents,
    hasPendingAction: debtGate.hasPendingAction,
    onOpenDebtFromHome: debtGate.openDebtFromHome,
    onOpenPendingFromHome: debtGate.openPendingFromHome,
    savedPlaces,
    greetingName: profileQuery.data?.name?.trim().split(/\s+/)[0] ?? null,
    onSelectDestination: selectDestination,
    onSeeAllSaved: goSavedPlaces,
    onSeeAllRecents: goTripHistory,
    onEnterSearch: enterSearch,
    onPickOnMap: pickOnMap,
    onEditOrigin: editOrigin,
    onSwapRoute: swapRoute,
    currentLocationTitle: origin?.title ?? reverseQuery.data?.title,
    destinationValue: destination?.title ?? undefined,
    lastDriver,
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
    <View style={[styles.root, {backgroundColor: theme.colors.bg}]}>
      {/* MAPA: persistente MIENTRAS el Home está enfocado, SOLO en las fases de pedido/viaje (route=ruta /
          trip=auto). En `idle` NO se renderiza mapa: el home es CONTENT-FIRST (fondo sólido `theme.colors.bg`
          del root + contenido full-screen). El guard `isFocused` lo DESMONTA al pushear otra pantalla encima
          (ver arriba el teardown del contexto GL): al volver, remonta. El borrador del viaje vive en Zustand
          y sobrevive al desmonte, así que no se pierde nada del flujo. */}
      <View style={StyleSheet.absoluteFill}>
        {!isFocused ? null : mapMode === 'route' ? (
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
        ) : mapMode === 'trip' ? (
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
            // Tipo REAL del viaje (store, congelado al crear): la moto se pinta moto. Sin dato → CAR.
            driverVehicleType={driverVehicleType}
            showDriverVehicle={mapDirective.showDriverVehicle}
            showUserPoint={mapDirective.showUserPoint}
            userPoint={mapDirective.showUserPoint ? myLocation : null}
            // En completed vuelve el AMBIENTE (autitos cercanos) además del userPoint (cierre del ciclo).
            nearbyVehicles={
              mapDirective.showNearby ? nearbyVehicles : undefined
            }
            cameraTarget={mapDirective.cameraTarget ?? undefined}
            // Polyline VIVA por fase (conductor→recojo en el acercamiento; conductor→destino onboard),
            // recalculada por el server cada 15 s. En el ACERCAMIENTO la congelada del quote (recojo→destino)
            // NO es fallback válido: mostraría la ruta a destino cuando el conductor recién viene — mejor
            // nada hasta que cargue la viva. El quote solo respalda al tramo onboard (es la MISMA ruta B→C).
            routeCoordinates={
              liveRouteCoords && liveRouteCoords.length > 1
                ? liveRouteCoords
                : phase === 'enRoute' || phase === 'arrived'
                  ? undefined
                  : routeCoords.length > 1
                    ? routeCoords
                    : undefined
            }
            // F3 · cuando el director NO dirige (cameraTarget null: aún sin conductor en pre-pickup/curso),
            // la Camera DECLARATIVA encuadra la ruta+markers (fitToRoute) en vez de quedar muda y derivar al
            // zoom-ciudad. Con conductor, manda el cameraTarget (director) y este fit se ignora. En
            // 'completed' (cameraTarget null pero sin querer fit de ruta) cae al center sobre mi ubicación.
            fitToRoute={
              mapDirective.cameraTarget == null && descriptor.activeTrip
            }
            fitEdgePadding={fitEdgePadding}
            // El encuadre lo gobierna el cameraTarget (director) cuando dirige; si no, el fit declarativo.
            // Sigue el snap ACTUAL del sheet (no solo el peek): el director RE-ENCUADRA al asentarse el
            // sheet en otro anclaje. El AppMap TOPA el valor a sus CAPs (fit/center) por seguridad.
            bottomInset={sheetMapInset + 16}
            interactive
          />
        ) : // `idle`: SIN mapa. El home es content-first (fondo sólido del root); el mapa aparece recién al
        // elegir destino → quoting (modo `route`). El contenido idle se renderiza full-screen más abajo.
        null}
      </View>

      {/* FONDO IDLE (sin mapa): imagen 3D de ciudad + scrim (pen P/Home). El CONTENIDO idle ya no vive
          acá: va en el MISMO DraggableSheet de abajo (con la piel de vidrio del pen y peek fijo a ~22.5%),
          para que el Home sea arrastrable y su lista scrollee cableada al gesto — un contenedor estático
          rompía ambas cosas. Va ANTES del HomeTopBar para que ese overlay absoluto siga tappable. */}
      {mapMode === 'idle' ? (
        <View style={styles.idleScreen}>
          {/* MAPA REAL debajo de la imagen, montado solo durante la BÚSQUEDA (+ su fade de salida):
              Mapbox centrado en mi ubicación con los autitos de ambiente. La imagen encima se
              desvanece y lo revela (crossfade del dueño: buscar = mapa vivo; volver = imagen). */}
          {searchMapMounted && isFocused ? (
            <View style={StyleSheet.absoluteFill}>
              <AppMap
                userPoint={myLocation}
                showUserPoint
                nearbyVehicles={
                  descriptor.showNearby ? nearbyVehicles : undefined
                }
                // También en búsqueda el foco (mi ubicación) queda centrado en la franja VISIBLE por
                // encima del sheet, y re-encuadra al colapsarlo/expandirlo. El AppMap capa el valor.
                bottomInset={sheetMapInset}
                interactive={false}
              />
            </View>
          ) : null}
          {/* Fondo del Home fiel a design/veo.pen P/Home (rect "Map"): la imagen COMPLETA mapeada a
              la altura de la pantalla — la MISMA matemática del pen (rect 390×844 con el arte de
              aspect idéntico). Tamaño EXPLÍCITO por aspect real del arte + "stretch" (no deforma:
              las medidas ya respetan la proporción): elimina cualquier zoom/crop del cover. */}
          <Animated.View
            style={[StyleSheet.absoluteFill, idleImageStyle]}
            pointerEvents="none">
            <Image
              source={homeMapBackdrop}
              style={[
                styles.idleBackdrop,
                {
                  height: windowHeight,
                  width: Math.round(windowHeight * HOME_BACKDROP_ASPECT),
                  left: Math.round(
                    (windowWidth - windowHeight * HOME_BACKDROP_ASPECT) / 2,
                  ),
                },
              ]}
              resizeMode="stretch"
            />
          </Animated.View>
          <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
            <Defs>
              {/* Scrim para imagen CLARA (Theme de Confianza): tope suave (deja ver la aérea + lifta la
                  legibilidad de la pill de ubicación), casi nada en el medio, y fade fuerte a `bg`
                  abajo para fundir sin costura en el sheet claro. */}
              <SvgLinearGradient id="homeScrim" x1="0" y1="0" x2="0" y2="1">
                <Stop
                  offset="0"
                  stopColor={theme.colors.bg}
                  stopOpacity={0.3}
                />
                <Stop
                  offset="0.34"
                  stopColor={theme.colors.bg}
                  stopOpacity={0.04}
                />
                <Stop
                  offset="0.6"
                  stopColor={theme.colors.bg}
                  stopOpacity={0.72}
                />
                <Stop
                  offset="1"
                  stopColor={theme.colors.bg}
                  stopOpacity={0.98}
                />
              </SvgLinearGradient>
            </Defs>
            <Rect
              x="0"
              y="0"
              width="100%"
              height="100%"
              fill="url(#homeScrim)"
            />
          </Svg>
        </View>
      ) : null}

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
          onOpenProfile={() => navigation.navigate('Profile')}
        />
      ) : (
        <TripTopBar
          // Minimizar (pen fLKdk MinBtn): colapsa el sheet al peek para despejar el mapa. El chat vive
          // ahora como acción "Mensaje" DENTRO del sheet (va por ctx a ActiveTripBody).
          onMinimize={() => sheetRef.current?.snapToIndex(PEEK_INDEX)}
          onSos={() =>
            navigation.navigate('Panic', {tripId: activeTripId as string})
          }
        />
      )}

      {/* CONTENIDO del flujo: UN solo BOTTOMSHEET ARRASTRABLE anclado abajo, para TODAS las fases.
          - idle: peek FIJO a la altura del pen (P/Home: HomeContent en y=190/844 ≈ 22.5% desde arriba) con
            la piel de vidrio del pen (gradiente + borde #4C5468); arrastrable a full y con la lista
            (favoritos/recientes) scrolleando cableada al gesto.
          - route/trip: peek content-hug sobre el mapa (igual que siempre).
          HEADER FIJO y BODY SCROLLABLE: ambos los declara el descriptor (Header null = autocontenido). */}
      <DraggableSheet
        ref={sheetRef}
        snapPoints={sheetSnapPoints}
        maxContentFraction={PEEK_MAX_FRACTION}
        // El Home MONTA en su reposo (la hoja del pen, índice 1); el colapsado (0) es solo por drag.
        initialIndex={restingIndex}
        onSnap={handleSnap}
        onPeekHeightChange={setPeekHeight}
        // Altura del snap ACTUAL (se asienta/re-mide, nunca por frame de drag): alimenta el re-encuadre
        // de la cámara del mapa al área visible (punto focal por encima del sheet en TODAS las fases).
        onSettledHeightChange={setSheetVisibleHeight}
        bottomOffset={bottomInset}
        renderHeader={() => (SheetHeader ? <SheetHeader ctx={ctx} /> : null)}
        renderScroll={ScrollComponent => (
          <ScrollComponent
            style={styles.sheetScroll}
            contentContainerStyle={[
              styles.sheetContent,
              {
                paddingHorizontal: theme.spacing.xl,
                // idle: el sheet llega al borde inferior y la TabBar flota ENCIMA → el final del scroll
                // la esquiva (inset + clearance). route/trip: respiro simple (el área útil ya descuenta
                // el chrome inferior vía bottomOffset).
                paddingBottom:
                  (mapMode === 'idle'
                    ? bottomInset + HOME_TABBAR_CLEARANCE
                    : theme.spacing.xl) +
                  // Buscando: clearance del teclado (iOS) para que la última sugerencia scrollee por
                  // encima de él (ver keyboard-avoidance arriba). Fuera de búsqueda es 0.
                  (flow === 'searching' ? keyboardHeight : 0),
                // Ritmo vertical del pen en el Home (HomeContent gap $s-lg = 16, con aire); el
                // resto de fases conserva md.
                gap: mapMode === 'idle' ? theme.spacing.lg : theme.spacing.md,
              },
            ]}
            showsVerticalScrollIndicator={false}>
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
        visible={
          descriptor.showsPushPrePrompt &&
          push.status === 'undetermined' &&
          !pushPrePromptSeen
        }
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
  root: {flex: 1},
  // Capa del pin de recojo (modelo Cabify): centra el pin en el centro GEOMÉTRICO del mapa — que es lo que
  // reporta onCenterChange — sobre el mapa y bajo el chrome. No intercepta gestos (pointerEvents none).
  pickupPinLayer: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Layout CONTENT-FIRST de la fase idle: ocupa toda la pantalla (flex:1 dentro del root) bajo el HomeTopBar
  // (sin mapa de fondo). El header (buscador "¿A dónde vamos?" + chips) queda fijo arriba y la lista
  // (favoritos/recientes) scrollea debajo. flex:1 (no absoluteFill) para no interceptar los toques del
  // HomeTopBar absoluto que flota encima.
  idleScreen: {flex: 1},
  // Backdrop del Home: absoluto anclado al top; alto/ancho/left EXPLÍCITOS (se inyectan por el
  // aspect real del arte) para replicar el mapeo imagen→frame del pen sin cover.
  idleBackdrop: {position: 'absolute', top: 0},
  sheetScroll: {flex: 1},
  sheetContent: {paddingTop: 4},
});
