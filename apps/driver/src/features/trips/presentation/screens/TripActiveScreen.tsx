import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  Avatar,
  Banner,
  BottomSheet,
  Button,
  MapShell,
  SafeScreen,
  Skeleton,
  StatusPill,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import { mobilePaymentMethod } from '@veo/api-client';
import type { RootStackParamList } from '../../../../navigation/types';
import { AppMap } from '../../../../shared/presentation/components/AppMap';
import { DraggableSheet } from '../../../../shared/presentation/components/DraggableSheet';
import { StateView } from '../../../../shared/presentation/components/StateView';
import { TopBar } from '../../../../shared/presentation/components/TopBar';
import { RadioOptionCard } from '../../../../shared/presentation/components/RadioOptionCard';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { formatPEN, metersToKm, secondsToMinutes } from '../../../../shared/presentation/format';
import { IconArrowLeft } from '../../../../shared/presentation/icons';
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

/**
 * Etiqueta de FASE del trayecto (lo que el conductor está HACIENDO ahora), NO el título genérico "Viaje
 * en curso": ACCEPTED/ARRIVING = yendo a recoger; ARRIVED = en el recojo; IN_PROGRESS = viaje en curso.
 * El resto cae al label de status normal (terminal/desconocido).
 */
function tripPhaseLabel(status: DriverTripStatus, t: TFunction): string {
  switch (status) {
    case 'ACCEPTED':
    case 'ARRIVING':
      return t('trips.phase.toPickup');
    case 'ARRIVED':
      return t('trips.phase.atPickup');
    case 'IN_PROGRESS':
      return t('trips.phase.inProgress');
    default:
      return statusLabel(status, t);
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
  const retryConfirm = () => {
    ensureAccepted.reset();
    triggeredRef.current = true;
    ensureMutate();
  };

  // Resumen métrico real del contrato (no hay turn-by-turn ni ETA): distancia + duración del viaje.
  const tripMetrics = `${t('trips.kilometers', { value: metersToKm(data.distanceMeters) })} · ${t('trips.minutes', { value: secondsToMinutes(data.durationSeconds) })}`;

  return (
    <SafeScreen padded={false} topInset={false}>
      {/* Área de mapa en vivo (hero). Cuando hay ruta del contrato se pinta la polyline y, sobre el
          mapa, el banner de la PRÓXIMA maniobra (prioridad: lo que el conductor necesita de un
          vistazo). Sin ruta aún, cae al banner de estado del viaje. */}
      <View style={styles.mapArea}>
        <MapShell
          live={status === 'ARRIVING' || status === 'IN_PROGRESS'}
          topOverlay={
            // Solo el banner de la PRÓXIMA maniobra (cuando hay ruta). El estado/fase + métricas ahora
            // viven en el sheet (sin duplicar), y NO hay appbar: el mapa es el hero, full-bleed.
            nextStep ? (
              <View style={[styles.maneuverWrap, { marginTop: insets.top + 8 }]}>
                <ManeuverBanner step={nextStep} remaining={tripRoute?.steps.length} />
              </View>
            ) : undefined
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

      {/* Sheet ARRASTRABLE dinámico al contenido (DraggableSheet · grabber en color primario/accent). Abraza
          su contenido y crece al expandir las indicaciones. SIN appbar: el back + chat viven en su header. */}
      <DraggableSheet
        snapPoints={['content', { content: 0.9 }]}
        maxContentFraction={0.74}
        renderScroll={(Scroll) => (
          <Scroll
            contentContainerStyle={[
              styles.sheetContent,
              { paddingBottom: insets.bottom + theme.spacing.xl },
            ]}
            showsVerticalScrollIndicator={false}
          >
            {/* Header DENTRO del sheet (sin appbar): back + FASE del trayecto + chat. */}
            <View style={styles.sheetHeader}>
              <Pressable
                onPress={navigation.goBack}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t('common.back')}
              >
                <IconArrowLeft size={24} color={theme.colors.ink} />
              </Pressable>
              <Text variant="title3" numberOfLines={1} style={styles.flex}>
                {tripPhaseLabel(status, t)}
              </Text>
              {chatTrailing}
            </View>

            {/* Card del pasajero: avatar (iniciales) + primer nombre (PII mínima post-aceptación) + tarifa. */}
            <View style={styles.passengerRow}>
              <Avatar
                name={data.passengerFirstName ?? undefined}
                size="lg"
                online={status === 'IN_PROGRESS'}
              />
              <View style={styles.flex}>
                <Text variant="footnote" color="inkMuted">
                  {t('trips.passenger')}
                </Text>
                <Text variant="title3" numberOfLines={1}>
                  {data.passengerFirstName ?? t('trips.passenger')}
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
            </View>

            {/* En vivo + métricas del trayecto (distancia · duración). */}
            <View style={styles.statusPillRow}>
              <StatusPill
                label={connected ? t('trips.connection.live') : t('trips.connection.reconnecting')}
                tone={connected ? 'brand' : 'neutral'}
                live={connected}
              />
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
        <Text variant="title3" color="success" style={styles.cashAmount}>
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
  mapArea: { flex: 1 },
  // Banner de la próxima maniobra sobre el mapa (marginTop dinámico en el JSX para respetar el notch).
  maneuverWrap: {},
  flex: { flex: 1 },
  // Header dentro del sheet (reemplaza el appbar): back + fase + chat en una fila.
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sheetContent: { paddingHorizontal: 20, paddingTop: 4, gap: 14 },
  passengerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  fareCol: { alignItems: 'flex-end' },
  statusPillRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  actions: { gap: 12, marginTop: 4 },
  sheetFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  spacer: { marginTop: 12 },
  cancelReasons: { gap: 8 },
  cashAmount: { textAlign: 'center', marginTop: 4 },
});
