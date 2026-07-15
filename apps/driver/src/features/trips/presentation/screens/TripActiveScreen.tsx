import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  Avatar,
  Banner,
  BottomSheet,
  Button,
  DraggableSheet,
  LiveBadge,
  MapShell,
  SafeScreen,
  Skeleton,
  StarGlyph,
  StatusPill,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import type { RootStackParamList } from '../../../../navigation/types';
import { AppMap } from '../../../../shared/presentation/components/AppMap';
import { MapViewModeButton } from '../../../../shared/presentation/components/MapViewModeButton';
import { StateView } from '../../../../shared/presentation/components/StateView';
import { TopBar } from '../../../../shared/presentation/components/TopBar';
import { RadioOptionCard } from '../../../../shared/presentation/components/RadioOptionCard';
import { isNotFoundError, toErrorMessage } from '../../../../shared/presentation/errors';
import {
  formatInt,
  formatPEN,
  metersToKm,
  secondsToMinutes,
} from '../../../../shared/presentation/format';
import { IconChevronLeft } from '../../../../shared/presentation/icons';
import { useSheetCameraInset } from '../../../../shared/presentation/hooks/useSheetCameraInset';
import { LIMA_CENTER } from '../../../../shared/utils/geo';
import { quantizePx, type SheetSnapSpec } from '../../../../shared/utils/mapCamera';
import { decodePolyline, decodePolylineToCoordinates } from '../../../../shared/utils/polyline';
import {
  EARNINGS_BREAKDOWN_QUERY_KEY,
  EARNINGS_DAILY_QUERY_KEY,
  EARNINGS_SUMMARY_QUERY_KEY,
} from '../../../earnings/domain';
import { useDispatchStore } from '../../../realtime/presentation/state/dispatchStore';
import { ChatButton, useChatStore } from '../../../chat/presentation';
import {
  isTripActive,
  parseTripStatus,
  upcomingManeuver,
  type DriverTripStatus,
} from '../../domain';
import { useActiveVehicle } from '../../../shift/presentation/hooks/useVehicleCatalog';
import { useEnsureTripAccepted, useTrip, useTripActions, useTripRoute } from '../hooks/useTrips';
import { useDriverWaypointProposal } from '../hooks/useDriverWaypointProposal';
import { useTripPublisher } from '../hooks/useTripPublisher';
import { WaypointProposalCard } from '../components/WaypointProposalCard';
import { useDriverPose } from '../components/useDriverPose';
import { ManeuverBanner } from '../components/ManeuverBanner';
import { RouteStepsList } from '../components/RouteStepsList';
import { ExternalNavButtons } from '../components/ExternalNavButtons';
import { Appear } from '../components/motion';

type Props = NativeStackScreenProps<RootStackParamList, 'TripActive'>;

/**
 * Motivos tipados de cancelación del conductor (frame C/Cancelar-Conductor). El orden es el del diseño;
 * `noShow` es el "no-show" (el pasajero no apareció). `other` abre el campo de texto libre.
 */
const CANCEL_REASON_KEYS = [
  'noShow',
  'wrongAddress',
  'vehicle',
  'passengerRequested',
  'other',
] as const;
type CancelReasonKey = (typeof CANCEL_REASON_KEYS)[number];

/**
 * Reintentos MANUALES de la confirmación ASSIGNED→ACCEPTED antes de declarar la oferta perdida.
 * Cada intento ya sondea el estado 8 veces (EnsureTripAcceptedUseCase): si tras el intento inicial
 * + 2 reintentos el viaje sigue sin ASSIGNED, la oferta murió — insistir es un bucle sin salida.
 */
const MAX_CONFIRM_RETRIES = 2;

/**
 * Terminales que pueden llegar ASINCRÓNICOS (socket `trip:update` o el poll de respaldo) mientras el
 * conductor maneja: el viaje muere bajo sus pies sin que él haya tocado nada. COMPLETED queda afuera
 * (tiene su propio cierre: botón al resumen TripComplete).
 */
const REMOTE_END_STATUSES = ['CANCELLED', 'EXPIRED', 'FAILED'] as const;
type RemoteEndStatus = (typeof REMOTE_END_STATUSES)[number];

/** Copy honesto por terminal remoto (claves i18n del banner "qué pasó" junto al botón Panel). */
const REMOTE_END_COPY: Record<RemoteEndStatus, { title: string; body: string }> = {
  CANCELLED: {
    title: 'trips.endedRemotely.cancelledTitle',
    body: 'trips.endedRemotely.cancelledBody',
  },
  EXPIRED: {
    title: 'trips.endedRemotely.expiredTitle',
    body: 'trips.endedRemotely.expiredBody',
  },
  FAILED: {
    title: 'trips.endedRemotely.failedTitle',
    body: 'trips.endedRemotely.failedBody',
  },
};

const isRemoteEndStatus = (s: DriverTripStatus): s is RemoteEndStatus =>
  (REMOTE_END_STATUSES as readonly DriverTripStatus[]).includes(s);

/* ── Cámara consciente del sheet/banner (área visible del mapa) ─────────────────────────────────
 * El foco de la cámara (puck en nav, ruta en fit) se centra en el área VISIBLE (viewport − sheet −
 * banner de maniobras) y se re-encuadra al asentarse cada snap. */

/**
 * Espejo 1:1 (mismo orden ascendente) de los `snapPoints` del DraggableSheet de esta pantalla
 * (`['header', 'content', { content: 0.94 }]` con `maxContentFraction` 0.74). CONSTRAINT: si cambian
 * los snapPoints/maxContentFraction del sheet, este espejo cambia con ellos.
 */
const TRIP_SHEET_SNAPS: ReadonlyArray<SheetSnapSpec> = [
  { kind: 'header' },
  { kind: 'content', capFraction: 0.74 },
  { kind: 'content', capFraction: 0.94 },
];
/** Índice inicial del sheet (= `initialIndex` del DraggableSheet). */
const TRIP_SHEET_INITIAL_INDEX = 1;

/** Offset del slot `topOverlay` del MapShell (ui-kit `styles.top` → `top: 12`), espejo. */
const MAPSHELL_TOP_OFFSET_PX = 12;
/** Margen entre el notch y el banner de maniobras (el `marginTop: insets.top + 8` del wrap). */
const MANEUVER_BANNER_TOP_MARGIN_PX = 8;
/** Cuantización del inset superior: jitter de ±px del banner no re-anima la cámara. */
const TOP_INSET_QUANTUM_PX = 8;
/** Aire entre el banner de maniobras (o el notch, sin banner) y el toggle 2D/3D flotante. */
const VIEW_MODE_BUTTON_GAP_PX = 12;

export const TripActiveScreen = ({ navigation, route }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { tripId } = route.params;
  const trip = useTrip(tripId);
  const actions = useTripActions(tripId);
  const ensureAccepted = useEnsureTripAccepted(tripId);
  const ensureMutate = ensureAccepted.mutate;
  const setActiveTripId = useDispatchStore((s) => s.setActiveTripId);
  // Estado de la conexión `/driver` en vivo: si el socket está caído (túnel, zona muerta) el conductor
  // ve "Reconectando…" en vez de creer que el viaje se actualiza en tiempo real cuando está aislado.
  const connected = useDispatchStore((s) => s.connected);
  const clearChat = useChatStore((s) => s.clear);

  // Pose del conductor (ubicación + rumbo) para pintar el mapa y la cámara de NAVEGACIÓN tipo Waze.
  // Degrada a null sin GPS nativo → sin pin y la cámara cae al encuadre normal (degradación honesta).
  const driverPose = useDriverPose();
  const driverLocation = driverPose?.point ?? null;

  // Vehículo activo (server-authoritative, cache compartido con el dashboard): el puck de navegación
  // lleva el glyph moto/auto. Sin dato aún → flecha genérica (el puck nunca espera a esta query).
  const activeVehicle = useActiveVehicle();

  // Cámara consciente del sheet: el DraggableSheet notifica el snap asentado (`onSnap`) y esta
  // pantalla mide header/contenido → `bottomInset` = alto visible del sheet (espejo de su math).
  const sheetInset = useSheetCameraInset(TRIP_SHEET_SNAPS, TRIP_SHEET_INITIAL_INDEX);
  // Alto medido del banner de maniobras (topOverlay del MapShell): define el inset superior.
  const [maneuverBannerPx, setManeuverBannerPx] = useState(0);

  // GAP 2: tras aceptar la oferta el viaje queda ASSIGNED; la máquina de estados exige ACCEPTED
  // antes de ARRIVING. Confirmamos la asignación (ASSIGNED→ACCEPTED) en cuanto llegamos a un viaje
  // aún sin aceptar; el usecase sondea el estado por si hay latencia dispatch→trip. Una sola vez.
  const triggeredRef = useRef(false);
  const rawStatus = trip.data?.status;
  useEffect(() => {
    if (triggeredRef.current || !rawStatus) {
      return;
    }
    const s = parseTripStatus(rawStatus);
    if (s === 'REQUESTED' || s === 'MATCHING' || s === 'ASSIGNED') {
      triggeredRef.current = true;
      ensureMutate();
    }
  }, [rawStatus, ensureMutate]);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelReasonKey, setCancelReasonKey] = useState<CancelReasonKey | null>(null);
  const [childOpen, setChildOpen] = useState(false);
  const [childCode, setChildCode] = useState('');
  // Reintentos manuales de `ensureAccepted` ya consumidos (gatea la salida limpia de `offerGone`).
  const [confirmRetries, setConfirmRetries] = useState(0);

  const status = trip.data ? parseTripStatus(trip.data.status) : 'UNKNOWN';

  // Un error de acción pertenece a SU intento: si la máquina AVANZÓ (una transición posterior tuvo
  // éxito), el banner viejo es ruido — se limpia. Sin esto, un 409 transitorio (p. ej. doble-tap del
  // accept) dejaba "Algo salió mal" pegado durante TODO el viaje aunque todo siguiera andando.
  useEffect(() => {
    actions.arriving.reset();
    actions.arrived.reset();
    actions.start.reset();
    actions.complete.reset();
    actions.cancel.reset();
    // Solo el STATUS dispara la limpieza (los objetos de mutación cambian de identidad por render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Terminal que llega ASINCRÓNICO (el pasajero canceló, venció, falló): el status cacheado cambia
  // por socket/poll SIN mutación propia y la UI solo cambiaba el botón a "Panel" — el conductor que
  // va manejando no se enteraba de que ya no tiene viaje. Se latchea el motivo para el banner. Los
  // cierres INICIADOS ACÁ (cancel/complete del conductor) navegan afuera en su onSuccess y se filtran
  // por la mutación local en vuelo/resuelta (leída en el render de la transición: el reset de arriba
  // recién impacta en el render siguiente, no corrompe esta lectura).
  const [remoteEnd, setRemoteEnd] = useState<RemoteEndStatus | null>(null);
  const queryClient = useQueryClient();
  const selfEnded =
    actions.cancel.isPending ||
    actions.cancel.isSuccess ||
    actions.complete.isPending ||
    actions.complete.isSuccess;
  useEffect(() => {
    if (isRemoteEndStatus(status) && !selfEnded) {
      setRemoteEnd(status);
      // Espejo del cierre PROPIO (`onTrip` de useTripActions): un terminal REMOTO también puede mover
      // la plata (una cancelación post-accept genera compensación al conductor) y este camino no pasa
      // por ninguna mutación → sin esto el "Neto de hoy" del dashboard quedaba stale tras una
      // cancelación del pasajero (cero GET /earnings/* en el driver-bff, confirmado en log).
      queryClient.invalidateQueries({ queryKey: EARNINGS_SUMMARY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: EARNINGS_BREAKDOWN_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: EARNINGS_DAILY_QUERY_KEY });
    }
    // Solo el STATUS dispara el latch: si dependiera de `selfEnded`, el reset de mutaciones de arriba
    // re-correría el efecto con el guard ya en false y marcaría como remoto un cierre propio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Parada propuesta por el pasajero (Lote C4): la propuesta entrante (socket) + el respond (POST). Solo
  // se ofrece en el viaje en curso (IN_PROGRESS), que es cuando el contrato permite proponer una parada.
  const waypointProposal = useDriverWaypointProposal(tripId);
  const showWaypointProposal = status === 'IN_PROGRESS' && waypointProposal.proposal !== null;

  // Publisher de seguridad: cámara+micrófono del habitáculo a la sala `trip:<tripId>` mientras el
  // viaje está en marcha (pasajero a bordo). Se detiene al completar/cancelar.
  useTripPublisher(tripId, status === 'IN_PROGRESS');

  // ─── NAVEGACIÓN turn-by-turn ───────────────────────────────────────────────────────────────
  // La ruta aporta valor mientras el conductor navega (yendo al recojo o llevando al pasajero):
  // ACCEPTED/ARRIVING/ARRIVED/IN_PROGRESS. Se desactiva en estados terminales para no pedir en vano.
  const isNavigating =
    status === 'ACCEPTED' ||
    status === 'ARRIVING' ||
    status === 'ARRIVED' ||
    status === 'IN_PROGRESS';
  // `driverPose?.point` = posición ACTUAL → el BFF traza la ruta desde donde está el conductor (ETA
  // vivo + próxima maniobra viva + re-ruteo por desvío). Sin GPS (null) la ruta sale del origen del viaje.
  const routeQuery = useTripRoute(tripId, isNavigating, driverPose?.point);
  const tripRoute = routeQuery.data;

  // Geometría de la ruta para pintarla en el mapa (GeoJSON [lng, lat]).
  const routeCoordinates = useMemo(
    () => (tripRoute ? decodePolylineToCoordinates(tripRoute.polyline) : undefined),
    [tripRoute],
  );

  // Próxima maniobra con distancia VIVA (contador GPS→punto de maniobra en cada tick, no el largo
  // del tramo congelado entre polls). Semántica OSRM: la que viene es la de steps[1], ubicada al
  // final de la geometría del paso actual (steps[0]). Derivación pura en el dominio (testeada).
  const maneuver = useMemo(
    () =>
      tripRoute
        ? upcomingManeuver(tripRoute.steps, driverPose?.point ?? null, (geometry) => {
            const points = decodePolyline(geometry);
            const end = points[points.length - 1];
            return end ? { lat: end.latitude, lon: end.longitude } : null;
          })
        : null,
    [tripRoute, driverPose?.point],
  );

  // Destino para el fallback de navegación externa: último punto de la geometría completa.
  const externalDestination = useMemo(() => {
    if (!tripRoute) {
      return null;
    }
    const points = decodePolyline(tripRoute.polyline);
    return points[points.length - 1] ?? null;
  }, [tripRoute]);

  const finishToDashboard = () => {
    setActiveTripId(null);
    clearChat(tripId);
    navigation.popToTop();
  };

  // Al COMPLETAR, en vez de volver directo al dashboard, mostramos el cierre del viaje (resumen de
  // ganancia + calificar al pasajero, frame C/TripComplete). Limpiamos el viaje activo + el chat (el
  // viaje terminó) y REEMPLAZAMOS TripActive por TripComplete (no se vuelve atrás a un viaje cerrado).
  // El botón "Listo" del cierre hace popToTop al dashboard. Sin `trip.data` (no debería en éxito),
  // degradamos al dashboard directo — nunca trabados.
  const goToComplete = () => {
    const active = trip.data;
    setActiveTripId(null);
    clearChat(tripId);
    if (!active) {
      navigation.popToTop();
      return;
    }
    navigation.replace('TripComplete', {
      tripId,
      passengerId: active.passengerId,
      fareCents: active.fareCents,
      // El método viaja al resumen: si es CASH, el cierre muestra la card de confirmación de cobro.
      paymentMethod: active.paymentMethod,
    });
  };

  const onStart = () => {
    if (trip.data?.childMode) {
      setChildOpen(true);
      return;
    }
    actions.start.mutate(undefined);
  };

  // EFECTIVO (decisión del dueño 2026-07-14): completar YA NO bloquea con el modal de cobro. TODOS los
  // métodos (efectivo o digital) completan al toque → ambas apps reaccionan al instante y navegamos al
  // resumen. En CASH, la confirmación de cobro se movió al resumen (TripComplete), POST-completado.
  const onComplete = () => {
    actions.complete.mutate(undefined, { onSuccess: goToComplete });
  };

  // Entrada al chat con el pasajero (con badge de no leídos). Solo tiene sentido mientras el viaje
  // sigue activo; si terminó/canceló queda deshabilitada (no se conversa con un viaje cerrado).
  const chatTrailing = (
    <ChatButton
      tripId={tripId}
      accessibilityLabel={t('chat.openWithBadge')}
      disabled={!isTripActive(status)}
      onPress={() => navigation.navigate('Chat', { tripId })}
    />
  );

  const header = (
    <TopBar title={t('trips.activeTitle')} onBack={navigation.goBack} trailing={chatTrailing} />
  );

  if (trip.isLoading) {
    return (
      <SafeScreen header={header}>
        <Skeleton height={240} />
      </SafeScreen>
    );
  }

  if (trip.isError || !trip.data) {
    return (
      <SafeScreen header={header}>
        <StateView
          title={t('errors.generic')}
          description={toErrorMessage(trip.error, t)}
          action={{ label: t('common.retry'), onPress: () => trip.refetch() }}
        />
      </SafeScreen>
    );
  }

  const data = trip.data;
  const anyBusy =
    actions.arriving.isPending ||
    actions.arrived.isPending ||
    actions.start.isPending ||
    actions.complete.isPending;
  // El error de `ensureAccepted` (ASSIGNED→ACCEPTED) NO va en este banner: esa transición tiene su PROPIA
  // UI (spinner "confirmando" + botón "reintentar" mientras `isPreAccepted`). Metía un "Algo salió mal /
  // revisá tu conexión" FANTASMA justo al aceptar (el usecase erra transitorio y se auto-recupera al quedar
  // ACCEPTED) — banner de un error ya resuelto. Acá solo los errores de ACCIÓN reales del viaje.
  const actionError =
    actions.arriving.error ??
    actions.arrived.error ??
    actions.start.error ??
    actions.complete.error ??
    actions.cancel.error;

  // Viaje aún sin aceptar (latencia dispatch→trip). `confirming` mientras corre el usecase;
  // `confirmFailed` si terminó sin lograr ACCEPTED (poll agotado o error) → ofrecer reintento.
  const isPreAccepted = status === 'REQUESTED' || status === 'MATCHING' || status === 'ASSIGNED';
  const confirming = isPreAccepted && (ensureAccepted.isPending || ensureAccepted.isIdle);
  const confirmFailed = isPreAccepted && (ensureAccepted.isError || ensureAccepted.isSuccess);
  // La oferta ya murió: el viaje da 404 (no es suyo / no existe) o los reintentos manuales se
  // agotaron sin ver ASSIGNED. Reintentar más es un bucle ciego sin salida — se ofrece volver al
  // dashboard con el motivo honesto en vez del "Reintentar" infinito.
  const offerGone =
    confirmFailed &&
    (isNotFoundError(ensureAccepted.error) || confirmRetries >= MAX_CONFIRM_RETRIES);
  const retryConfirm = () => {
    setConfirmRetries((n) => n + 1);
    ensureAccepted.reset();
    triggeredRef.current = true;
    ensureMutate();
  };

  // Resumen métrico real del contrato (no hay turn-by-turn ni ETA): distancia + duración del viaje.
  const tripMetrics = `${t('trips.kilometers', { value: metersToKm(data.distanceMeters) })} · ${t('trips.minutes', { value: secondsToMinutes(data.durationSeconds) })}`;

  // Inset SUPERIOR del área visible del mapa: con banner de maniobras, el offset del MapShell + el
  // notch + el margen + el alto medido del banner; sin banner, solo el notch. Cuantizado: el jitter
  // de layout no re-anima la cámara.
  const mapTopInset = quantizePx(
    maneuver
      ? MAPSHELL_TOP_OFFSET_PX + insets.top + MANEUVER_BANNER_TOP_MARGIN_PX + maneuverBannerPx
      : insets.top,
    TOP_INSET_QUANTUM_PX,
  );

  return (
    <SafeScreen padded={false} topInset={false}>
      {/* Área de mapa en vivo (hero). Cuando hay ruta del contrato se pinta la polyline y, sobre el
          mapa, el banner de la PRÓXIMA maniobra (prioridad: lo que el conductor necesita de un
          vistazo). Sin ruta aún, cae al banner de estado del viaje. */}
      <View style={styles.mapArea}>
        <MapShell
          // El "EN VIVO" ya NO es el StatusPill accent top-left de MapShell: es el LiveBadge (card blanca
          // cámara, MISMA identidad que el pasajero) ENCIMADO sobre la card de maniobra (abajo).
          live={false}
          topOverlay={
            // Banner de la PRÓXIMA maniobra (cuando hay ruta) con el LiveBadge encimado en su borde superior.
            // El estado/fase + métricas viven en el sheet (sin duplicar); el mapa es el hero, full-bleed.
            maneuver ? (
              <View
                style={[
                  styles.maneuverWrap,
                  { marginTop: insets.top + MANEUVER_BANNER_TOP_MARGIN_PX },
                ]}
                // Mide el alto del banner: define el inset superior del área visible de la cámara.
                onLayout={(e) => setManeuverBannerPx(Math.round(e.nativeEvent.layout.height))}
              >
                <ManeuverBanner
                  step={maneuver.step}
                  distanceMeters={maneuver.distanceMeters}
                  remaining={tripRoute?.steps.length}
                  onboard={status === 'IN_PROGRESS'}
                />
                {/* LiveBadge centrado, PISANDO el borde superior de la maniobra (encimado). Absolute → no
                    afecta el alto medido para el inset de la cámara. */}
                {status === 'ARRIVING' || status === 'IN_PROGRESS' ? (
                  <View style={styles.liveBadgeStraddle} pointerEvents="none">
                    <LiveBadge label={t('trips.live')} />
                  </View>
                ) : null}
              </View>
            ) : undefined
          }
        >
          <AppMap
            center={driverLocation ?? LIMA_CENTER}
            driver={driverLocation}
            // Con el pasajero A BORDO el recojo ya quedó atrás: su pin se APAGA (el mapa comunica la
            // fase — antes quedaba pintado todo el viaje aunque la polyline ya no pasara por ahí).
            origin={status === 'IN_PROGRESS' ? undefined : tripRoute?.origin}
            destination={tripRoute?.destination}
            waypoints={tripRoute?.waypoints}
            routeCoordinates={routeCoordinates}
            fitToRoute={Boolean(routeCoordinates && routeCoordinates.length >= 2)}
            navMode
            heading={driverPose?.heading ?? null}
            // Área visible: la cámara descuenta el banner (arriba) y el sheet en su snap (abajo).
            topInset={mapTopInset}
            bottomInset={sheetInset.bottomInset}
            vehicleType={activeVehicle.data?.vehicleType ?? null}
            interactive={false}
          />
        </MapShell>
        {/* Toggle 2D/3D flotante (arriba-derecha): debajo del banner de maniobras cuando hay ruta —
            usa el MISMO inset medido que la cámara — o bajo el notch cuando no. */}
        <MapViewModeButton topInset={mapTopInset + VIEW_MODE_BUTTON_GAP_PX} />
      </View>

      {/* Sheet ARRASTRABLE dinámico al contenido (DraggableSheet · grabber en color primario/accent). Abraza
          su contenido y crece al expandir las indicaciones. SIN appbar: el back + chat viven en su header. */}
      <DraggableSheet
        // CONSTRAINT: snapPoints/maxContentFraction/initialIndex tienen su espejo en TRIP_SHEET_SNAPS
        // (cámara consciente del sheet) — cambiarlos acá exige cambiar el espejo.
        snapPoints={['header', 'content', { content: 0.94 }]}
        maxContentFraction={0.74}
        initialIndex={TRIP_SHEET_INITIAL_INDEX}
        // Al asentarse cada snap, la cámara re-encuadra el área visible (no persigue el drag).
        onSnap={sheetInset.onSnap}
        renderHeader={() => (
          // Header FIJO (visible en TODOS los estados, incluido el COLAPSADO): back (chevron iOS) + chat.
          // Arrastrando el grabber hacia abajo, el sheet COLAPSA a solo este header (con rebote) → el mapa
          // queda máximo, viéndose únicamente el chevron ‹ y el ícono de mensaje.
          <View style={styles.sheetHeader} onLayout={sheetInset.onHeaderLayout}>
            <Pressable
              onPress={navigation.goBack}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t('common.back')}
            >
              <IconChevronLeft size={28} color={theme.colors.ink} strokeWidth={2.25} />
            </Pressable>
            <View style={styles.flex} />
            {chatTrailing}
          </View>
        )}
        renderScroll={(Scroll) => (
          <Scroll showsVerticalScrollIndicator={false}>
            {/* Wrapper MEDIDO del contenido (mismo layout que el contentContainerStyle previo — el
                sheet de ui-kit mide idéntico): su alto alimenta la cámara consciente del sheet. */}
            <View
              onLayout={sheetInset.onContentLayout}
              style={[styles.sheetContent, { paddingBottom: insets.bottom + theme.spacing.xl }]}
            >
            {/* Card del pasajero: avatar (iniciales) + primer nombre (PII mínima post-aceptación) + tarifa. */}
            <View style={styles.passengerRow}>
              <Avatar
                name={data.passengerFirstName ?? undefined}
                size="lg"
                online={status === 'IN_PROGRESS'}
              />
              <View style={styles.flex}>
                <Text variant="title3" numberOfLines={1}>
                  {data.passengerFirstName ?? t('trips.passenger')}
                </Text>
                {/* Valoración + cantidad de viajes del PASAJERO (simétrico a lo que ve el pasajero del
                    conductor): estrellas (redondeadas) + "4.9 · N viajes" del contrato. Sin rating →
                    "Pasajero nuevo" (sin estrellas), nunca en blanco. Es un AGREGADO (no PII). */}
                {data.passengerRating != null ? (
                  <View style={styles.paxRatingRow}>
                    <View style={styles.paxStars}>
                      {[0, 1, 2, 3, 4].map((i) => (
                        <StarGlyph
                          key={i}
                          color={theme.colors.warn}
                          size={12}
                          filled={i < Math.round(data.passengerRating as number)}
                        />
                      ))}
                    </View>
                    <Text variant="caption" color="inkMuted" tabular>
                      {(data.passengerTripCount ?? 0) > 0
                        ? t('trips.passengerRatingTrips', {
                            rating: data.passengerRating.toFixed(1),
                            trips: formatInt(data.passengerTripCount ?? 0),
                          })
                        : data.passengerRating.toFixed(1)}
                    </Text>
                  </View>
                ) : (
                  <Text variant="caption" color="inkMuted">
                    {t('trips.passengerNew')}
                  </Text>
                )}
              </View>
              <View style={styles.fareCol}>
                <Text variant="footnote" color="inkMuted" align="right">
                  {t('trips.fare')}
                </Text>
                <Text variant="title3" tabular align="right">
                  {formatPEN(data.fareCents)}
                </Text>
              </View>
            </View>

            {/* Métricas del trayecto (distancia · duración). U2 · dedup: el "En vivo" ya lo porta el
                LiveBadge del mapa — la pill del sheet SOLO aparece en degradación ("Reconectando…"
                cuando el socket está caído); en verde no renderiza nada. */}
            <View style={styles.statusPillRow}>
              {connected ? null : (
                <StatusPill label={t('trips.connection.reconnecting')} tone="neutral" />
              )}
              <Text variant="footnote" color="inkMuted" tabular>
                {tripMetrics}
              </Text>
            </View>

            {data.childMode ? (
              <Banner tone="info" title={t('trips.childMode')} description={t('trips.childModeHint')} />
            ) : null}

            {isNavigating && routeQuery.isError ? (
              <Banner tone="warn" title={t('navigation.routeUnavailable')} />
            ) : null}

            {actionError ? (
              <Banner
                tone="danger"
                title={t('errors.generic')}
                description={toErrorMessage(actionError, t)}
              />
            ) : null}

            {/* Parada propuesta por el pasajero (Lote C4): aceptar/rechazar, solo en curso. */}
            {showWaypointProposal && waypointProposal.proposal ? (
              <Appear key="waypoint-proposal">
                <WaypointProposalCard
                  proposal={waypointProposal.proposal}
                  isResponding={waypointProposal.isResponding}
                  isError={waypointProposal.isError}
                  onRespond={waypointProposal.respond}
                />
              </Appear>
            ) : null}

            {/* ACCIONES (principal de la FSM + salidas) — en el peek, siempre visibles. */}
            <Appear key={`actions-${status}`} style={styles.actions}>
          {confirming ? (
            <Button label={t('trips.confirmingAssignment')} fullWidth loading disabled />
          ) : null}
          {/* Oferta perdida (404 o reintentos agotados): motivo honesto + salida limpia al dashboard
              (mismo patrón Banner + Button del resto de la pantalla), en vez del reintento infinito. */}
          {confirmFailed && offerGone ? (
            <>
              <Banner
                tone="warn"
                title={t('trips.offerGoneTitle')}
                description={t('trips.offerGoneBody')}
              />
              <Button label={t('shift.dashboardTitle')} fullWidth onPress={finishToDashboard} />
            </>
          ) : null}
          {confirmFailed && !offerGone ? (
            <Button label={t('common.retry')} fullWidth onPress={retryConfirm} />
          ) : null}
          {status === 'ACCEPTED' ? (
            <Button
              label={t('trips.actions.arriving')}
              variant="accent"
              fullWidth
              loading={anyBusy}
              onPress={() => actions.arriving.mutate()}
            />
          ) : null}
          {status === 'ARRIVING' ? (
            <Button
              label={t('trips.actions.arrived')}
              variant="accent"
              fullWidth
              loading={anyBusy}
              onPress={() => actions.arrived.mutate()}
            />
          ) : null}
          {status === 'ARRIVED' ? (
            <Button
              label={t('trips.actions.start')}
              variant="safe"
              fullWidth
              loading={anyBusy}
              onPress={onStart}
            />
          ) : null}
          {status === 'IN_PROGRESS' ? (
            <Button
              label={t('trips.actions.complete')}
              variant="safe"
              fullWidth
              loading={anyBusy}
              onPress={onComplete}
            />
          ) : null}

          {/* Salida al dashboard cuando el viaje NO es accionable: cualquier cierre (completado,
              cancelado, vencido, fallido, reasignado) Y TAMBIÉN un estado UNKNOWN (contrato no reconocido).
              `!isTripActive` = terminal o desconocido → siempre hay botón para volver, nunca trabado. */}
          {/* Cierre no accionable: si el viaje se COMPLETÓ (p. ej. estado llegado por socket), el botón
              lleva al resumen + rating (TripComplete); para otros cierres (cancelado/vencido/fallido) o
              UNKNOWN, vuelve directo al dashboard — nunca trabado. */}
          {/* Cierre REMOTO (asincrónico, no iniciado por el conductor): decir QUÉ pasó junto al botón
              "Panel" (mismo patrón Banner que offerGone), no solo cambiar el botón en silencio. */}
          {remoteEnd ? (
            <Banner
              tone="warn"
              title={t(REMOTE_END_COPY[remoteEnd].title)}
              description={t(REMOTE_END_COPY[remoteEnd].body)}
            />
          ) : null}
          {!isTripActive(status) ? (
            <Button
              label={t('shift.dashboardTitle')}
              fullWidth
              onPress={status === 'COMPLETED' ? goToComplete : finishToDashboard}
            />
          ) : null}

              {isTripActive(status) && status !== 'IN_PROGRESS' ? (
                <Button
                  label={t('trips.actions.cancel')}
                  variant="ghost"
                  fullWidth
                  onPress={() => setCancelOpen(true)}
                />
              ) : null}
            </Appear>

            {/* INDICACIONES turn-by-turn (se revelan al arrastrar/expandir el sheet → crece dinámico):
                pasos + fallback a nav externa. Solo con ruta. El banner de la próxima maniobra ya va sobre el mapa. */}
            {isNavigating && tripRoute ? (
              <>
                <RouteStepsList
                  steps={tripRoute.steps}
                  totalDistanceMeters={tripRoute.distanceMeters}
                />
                <ExternalNavButtons destination={externalDestination} />
              </>
            ) : null}
            </View>
          </Scroll>
        )}
      />

      <BottomSheet
        visible={cancelOpen}
        onClose={() => {
          setCancelOpen(false);
          setCancelReasonKey(null);
          setCancelReason('');
        }}
        title={t('trips.cancelReason.title')}
        footer={
          <View style={styles.sheetFooter}>
            <Button
              label={t('common.back')}
              variant="secondary"
              onPress={() => {
                setCancelOpen(false);
                setCancelReasonKey(null);
                setCancelReason('');
              }}
            />
            <Button
              label={t('trips.cancelReason.confirm')}
              variant="danger"
              loading={actions.cancel.isPending}
              // Deshabilitado hasta elegir un motivo; si es "Otro", exige el texto libre.
              disabled={
                cancelReasonKey == null ||
                (cancelReasonKey === 'other' && cancelReason.trim().length === 0)
              }
              onPress={() => {
                // El motivo elegido viaja como `reason` al POST /trips/:id/cancel: los tipados como su
                // etiqueta legible; "Otro" como el texto libre que escribió el conductor.
                const reason =
                  cancelReasonKey === 'other'
                    ? cancelReason.trim()
                    : cancelReasonKey
                      ? t(`trips.cancelReason.reasons.${cancelReasonKey}`)
                      : undefined;
                actions.cancel.mutate(reason || undefined, {
                  onSuccess: finishToDashboard,
                });
              }}
            />
          </View>
        }
      >
        <View style={styles.cancelReasons}>
          {CANCEL_REASON_KEYS.map((key) => (
            <RadioOptionCard
              key={key}
              label={t(`trips.cancelReason.reasons.${key}`)}
              selected={cancelReasonKey === key}
              onPress={() => setCancelReasonKey(key)}
            />
          ))}
          {cancelReasonKey === 'other' ? (
            <TextField
              label={t('trips.cancelReason.otherLabel')}
              value={cancelReason}
              onChangeText={setCancelReason}
              multiline
            />
          ) : null}
          {/* Se mantiene el aviso de cargo/tasa del frame (afecta la tasa de aceptación). */}
          <Banner tone="warn" title={t('trips.cancelReason.warn')} />
        </View>
      </BottomSheet>

      <BottomSheet
        visible={childOpen}
        onClose={() => setChildOpen(false)}
        title={t('trips.childMode')}
        footer={
          <View style={styles.sheetFooter}>
            <Button
              label={t('common.cancel')}
              variant="secondary"
              onPress={() => setChildOpen(false)}
            />
            <Button
              label={t('trips.actions.start')}
              variant="safe"
              disabled={!/^\d{4,6}$/.test(childCode)}
              loading={actions.start.isPending}
              onPress={() => {
                setChildOpen(false);
                actions.start.mutate(childCode);
                setChildCode('');
              }}
            />
          </View>
        }
      >
        <Text variant="callout" color="inkMuted" style={styles.spacer}>
          {t('trips.childModeHint')}
        </Text>
        <TextField
          label={t('trips.childCodeLabel')}
          helperText={t('trips.childCodeHelper')}
          value={childCode}
          onChangeText={setChildCode}
          keyboardType="number-pad"
          maxLength={6}
        />
      </BottomSheet>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  mapArea: { flex: 1 },
  // Banner de la próxima maniobra sobre el mapa (marginTop dinámico en el JSX para respetar el notch).
  maneuverWrap: {},
  // LiveBadge centrado, encimado en el borde superior de la maniobra (~mitad arriba, mitad sobre la card).
  // top ≈ -(alto del pill/2). Absolute → fuera del flujo (no altera el alto medido para el inset de cámara).
  liveBadgeStraddle: {
    position: 'absolute',
    top: -18,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10,
  },
  flex: { flex: 1 },
  // Header FIJO del sheet (renderHeader, fuera del scroll): back + chat. Lleva su propio padding porque no
  // está dentro del contenedor padded del scroll. Visible en el estado colapsado ('header').
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    // paddingTop generoso: el badge de no-leídos del chat (top:-4 sobre el IconButton) quedaba pegado al
    // borde superior del sheet (overflow:hidden + esquina redondeada) y se recortaba/veía subtle. Con aire
    // arriba, el badge se ve completo. También da mejor ritmo al header colapsado.
    paddingTop: 10,
    paddingBottom: 10,
  },
  sheetContent: { paddingHorizontal: 20, paddingTop: 2, gap: 14 },
  passengerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  paxRatingRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  paxStars: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  fareCol: { alignItems: 'flex-end' },
  statusPillRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  actions: { gap: 12, marginTop: 4 },
  sheetFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  spacer: { marginTop: 12 },
  cancelReasons: { gap: 8 },
});
