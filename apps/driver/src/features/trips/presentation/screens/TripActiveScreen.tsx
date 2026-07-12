import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  Avatar,
  Banner,
  BottomSheet,
  Button,
  Card,
  MapShell,
  SafeScreen,
  Skeleton,
  StatusPill,
  Text,
  TextField,
  useTheme,
  type StatusTone,
} from '@veo/ui-kit';
import { mobilePaymentMethod } from '@veo/api-client';
import type { RootStackParamList } from '../../../../navigation/types';
import { AppMap } from '../../../../shared/presentation/components/AppMap';
import { GlassSheet } from '../../../../shared/presentation/components/GlassSheet';
import { StateView } from '../../../../shared/presentation/components/StateView';
import { TopBar } from '../../../../shared/presentation/components/TopBar';
import { RadioOptionCard } from '../../../../shared/presentation/components/RadioOptionCard';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { formatPEN, metersToKm, secondsToMinutes } from '../../../../shared/presentation/format';
import { IconNavigation } from '../../../../shared/presentation/icons';
import { LIMA_CENTER } from '../../../../shared/utils/geo';
import { decodePolyline, decodePolylineToCoordinates } from '../../../../shared/utils/polyline';
import { useDispatchStore } from '../../../realtime/presentation/state/dispatchStore';
import { ChatButton, useChatStore } from '../../../chat/presentation';
import { isTripActive, parseTripStatus, type DriverTripStatus } from '../../domain';
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

const statusTone: Record<DriverTripStatus, StatusTone> = {
  REQUESTED: 'neutral',
  MATCHING: 'neutral',
  SCHEDULED: 'brand',
  ASSIGNED: 'brand',
  ACCEPTED: 'brand',
  ARRIVING: 'accent',
  ARRIVED: 'accent',
  IN_PROGRESS: 'success',
  COMPLETED: 'success',
  CANCELLED: 'danger',
  // Estados añadidos al contrato (@veo/api-client) que el mapa de tonos debe cubrir de forma
  // exhaustiva: REASSIGNING es transitorio (re-puja, activo → accent); EXPIRED/FAILED son cierres
  // sin éxito (neutral/danger). Sin esto el Record no es exhaustivo sobre DriverTripStatus.
  REASSIGNING: 'accent',
  EXPIRED: 'neutral',
  FAILED: 'danger',
  UNKNOWN: 'neutral',
};

function statusLabel(status: DriverTripStatus, t: TFunction): string {
  switch (status) {
    case 'SCHEDULED':
      return t('trips.status.scheduled');
    case 'ASSIGNED':
      return t('trips.status.assigned');
    case 'ACCEPTED':
      return t('trips.status.accepted');
    case 'ARRIVING':
      return t('trips.status.arriving');
    case 'ARRIVED':
      return t('trips.status.arrived');
    case 'IN_PROGRESS':
      return t('trips.status.inProgress');
    case 'COMPLETED':
      return t('trips.status.completed');
    case 'CANCELLED':
      return t('trips.status.cancelled');
    case 'EXPIRED':
      return t('trips.status.expired');
    case 'FAILED':
      return t('trips.status.failed');
    case 'REASSIGNING':
      return t('trips.status.reassigning');
    default:
      return t('trips.status.unknown');
  }
}

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
  const [cashOpen, setCashOpen] = useState(false);

  const status = trip.data ? parseTripStatus(trip.data.status) : 'UNKNOWN';

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

  // Próxima maniobra = primer paso de la ruta (el server devuelve los pasos pendientes ordenados).
  const nextStep = tripRoute?.steps[0];

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
    });
  };

  const onStart = () => {
    if (trip.data?.childMode) {
      setChildOpen(true);
      return;
    }
    actions.start.mutate(undefined);
  };

  // EFECTIVO (BR-P03): en un viaje CASH, terminar abre la confirmación de cobro (el conductor marca
  // que recibió el efectivo en mano → driverConfirmed). En digital, completa directo (sin sheet).
  const isCashTrip = trip.data?.paymentMethod === mobilePaymentMethod.enum.CASH;
  const onComplete = () => {
    if (isCashTrip) {
      setCashOpen(true);
      return;
    }
    actions.complete.mutate(undefined, { onSuccess: goToComplete });
  };

  // Cierra el viaje declarando si se cobró el efectivo. `collected=false` lo termina igual (flujo
  // bilateral: el cobro queda a la espera de la confirmación del pasajero), nunca data falsa.
  const completeCash = (collected: boolean) => {
    setCashOpen(false);
    actions.complete.mutate({ cashCollected: collected }, { onSuccess: goToComplete });
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
  const actionError =
    ensureAccepted.error ??
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
  const retryConfirm = () => {
    ensureAccepted.reset();
    triggeredRef.current = true;
    ensureMutate();
  };

  // Resumen métrico real del contrato (no hay turn-by-turn ni ETA): distancia + duración del viaje.
  const tripMetrics = `${t('trips.kilometers', { value: metersToKm(data.distanceMeters) })} · ${t('trips.minutes', { value: secondsToMinutes(data.durationSeconds) })}`;

  return (
    <SafeScreen padded={false} header={<View style={styles.headerPad}>{header}</View>}>
      {/* Área de mapa en vivo (hero). Cuando hay ruta del contrato se pinta la polyline y, sobre el
          mapa, el banner de la PRÓXIMA maniobra (prioridad: lo que el conductor necesita de un
          vistazo). Sin ruta aún, cae al banner de estado del viaje. */}
      <View style={styles.mapArea}>
        <MapShell
          live={status === 'ARRIVING' || status === 'IN_PROGRESS'}
          topOverlay={
            nextStep ? (
              <View style={styles.maneuverWrap}>
                <ManeuverBanner step={nextStep} remaining={tripRoute?.steps.length} />
              </View>
            ) : (
              <Appear key={status} style={styles.statusBanner}>
                <Card variant="filled">
                  <View style={styles.statusRow}>
                    <View
                      style={[
                        styles.statusIcon,
                        { backgroundColor: theme.colors.surface, borderRadius: theme.radii.md },
                      ]}
                    >
                      <IconNavigation size={22} color={theme.colors.accent} />
                    </View>
                    <View style={styles.flex}>
                      <Text variant="title3" numberOfLines={1}>
                        {statusLabel(status, t)}
                      </Text>
                      <Text variant="footnote" color="inkMuted" tabular>
                        {tripMetrics}
                      </Text>
                    </View>
                  </View>
                </Card>
              </Appear>
            )
          }
        >
          <AppMap
            center={driverLocation ?? LIMA_CENTER}
            driver={driverLocation}
            origin={tripRoute?.origin}
            destination={tripRoute?.destination}
            waypoints={tripRoute?.waypoints}
            routeCoordinates={routeCoordinates}
            fitToRoute={Boolean(routeCoordinates && routeCoordinates.length >= 2)}
            navMode
            heading={driverPose?.heading ?? null}
            interactive={false}
          />
        </MapShell>
      </View>

      {/* Sheet inferior: panel del pasajero + estado + acción principal de la FSM. Glass sheet CLARO
          (Theme de Confianza) vía el componente compartido `GlassSheet` en modo scroll — el frosted
          ~96% blanco + borde sutil + esquinas superiores vive ahí (antes era inline). */}
      <GlassSheet
        scrollable
        style={styles.sheet}
        contentContainerStyle={[
          styles.sheetContent,
          { paddingBottom: insets.bottom + theme.spacing.xl },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <Appear style={styles.passengerRow}>
          <Avatar size="lg" online={status === 'IN_PROGRESS'} />
          <View style={styles.flex}>
            <Text variant="footnote" color="inkMuted">
              {t('trips.activeTitle')}
            </Text>
            <Text variant="title3" numberOfLines={1}>
              {statusLabel(status, t)}
            </Text>
          </View>
          <View style={styles.fareCol}>
            <Text variant="footnote" color="inkMuted" align="right">
              {t('trips.fare')}
            </Text>
            <Text variant="title3" tabular align="right">
              {formatPEN(data.fareCents)}
            </Text>
          </View>
        </Appear>

        <Appear key={`pill-${status}`} style={styles.statusPillRow}>
          <StatusPill label={statusLabel(status, t)} tone={statusTone[status]} dot />
          {/* Indicador de conexión en vivo: "En vivo" (pulso) cuando el socket está conectado;
              "Reconectando…" (neutral, sin pulso) cuando se cayó. Igual que el board del pasajero. */}
          <StatusPill
            label={connected ? t('trips.connection.live') : t('trips.connection.reconnecting')}
            tone={connected ? 'brand' : 'neutral'}
            live={connected}
          />
        </Appear>

        {data.childMode ? (
          <Banner tone="info" title={t('trips.childMode')} description={t('trips.childModeHint')} />
        ) : null}

        {/* Navegación turn-by-turn: lista desplegable de pasos + fallback a apps externas. El banner
            de la próxima maniobra ya vive sobre el mapa (prioridad). Solo cuando hay ruta. */}
        {isNavigating && tripRoute ? (
          <>
            <RouteStepsList
              steps={tripRoute.steps}
              totalDistanceMeters={tripRoute.distanceMeters}
            />
            <ExternalNavButtons destination={externalDestination} />
          </>
        ) : null}

        {/* Mientras se consigue la ruta de navegación, avisa de forma discreta. */}
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

        {/* Parada propuesta por el pasajero (Lote C4): tarjeta para aceptar/rechazar, sobre las acciones
            normales del viaje, solo en curso. El server recalcula tarifa+ruta si el conductor acepta. */}
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

        <Appear key={`actions-${status}`} style={styles.actions}>
          {confirming ? (
            <Button label={t('trips.confirmingAssignment')} fullWidth loading disabled />
          ) : null}
          {confirmFailed ? (
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
      </GlassSheet>

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

      {/* EFECTIVO (BR-P03): confirmación de cobro al terminar un viaje CASH. El monto se muestra para que
          el conductor coteje lo que cobró en mano; ambas opciones cierran el viaje (cobrado o pendiente). */}
      <BottomSheet
        visible={cashOpen}
        onClose={() => setCashOpen(false)}
        title={t('trips.cashCollectTitle')}
        footer={
          <View style={styles.sheetFooter}>
            <Button
              label={t('trips.cashCollectSkip')}
              variant="secondary"
              disabled={actions.complete.isPending}
              onPress={() => completeCash(false)}
            />
            <Button
              label={t('trips.cashCollectConfirm', {
                amount: formatPEN(trip.data?.fareCents ?? 0),
              })}
              variant="safe"
              loading={actions.complete.isPending}
              onPress={() => completeCash(true)}
            />
          </View>
        }
      >
        <Text variant="title3" style={styles.cashAmount}>
          {formatPEN(trip.data?.fareCents ?? 0)}
        </Text>
        <Text variant="callout" color="inkMuted" style={styles.spacer}>
          {t('trips.cashCollectBody')}
        </Text>
      </BottomSheet>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  headerPad: { paddingHorizontal: 20 },
  mapArea: { flex: 1 },
  // Empuja el banner de estado por debajo del pill "EN VIVO" de MapShell (esquina superior izq.).
  statusBanner: { marginTop: 32 },
  // Banner de maniobra: mismo respiro bajo el pill "EN VIVO".
  maneuverWrap: { marginTop: 32 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  statusIcon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  sheet: { flexShrink: 0, maxHeight: '46%' },
  sheetContent: { paddingHorizontal: 20, paddingTop: 16, gap: 14 },
  passengerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  fareCol: { alignItems: 'flex-end' },
  statusPillRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  actions: { gap: 12, marginTop: 4 },
  sheetFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  spacer: { marginTop: 12 },
  cancelReasons: { gap: 8 },
  cashAmount: { textAlign: 'center', marginTop: 4 },
});
