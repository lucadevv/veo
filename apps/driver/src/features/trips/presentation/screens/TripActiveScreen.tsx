import React, {useEffect, useMemo, useRef, useState} from 'react';
import {ScrollView, StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import type {TFunction} from 'i18next';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
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
import type {RootStackParamList} from '../../../../navigation/types';
import {AppMap} from '../../../../shared/presentation/components/AppMap';
import {StateView} from '../../../../shared/presentation/components/StateView';
import {TopBar} from '../../../../shared/presentation/components/TopBar';
import {toErrorMessage} from '../../../../shared/presentation/errors';
import {formatPEN, metersToKm, secondsToMinutes} from '../../../../shared/presentation/format';
import {IconNavigation} from '../../../../shared/presentation/icons';
import {LIMA_CENTER} from '../../../../shared/utils/geo';
import {decodePolyline, decodePolylineToCoordinates} from '../../../../shared/utils/polyline';
import {useDispatchStore} from '../../../realtime/presentation/state/dispatchStore';
import {ChatButton, useChatStore} from '../../../chat/presentation';
import {isTripActive, parseTripStatus, type DriverTripStatus} from '../../domain';
import {useEnsureTripAccepted, useTrip, useTripActions, useTripRoute} from '../hooks/useTrips';
import {useTripPublisher} from '../hooks/useTripPublisher';
import {useDriverLocation} from '../components/useDriverLocation';
import {ManeuverBanner} from '../components/ManeuverBanner';
import {RouteStepsList} from '../components/RouteStepsList';
import {ExternalNavButtons} from '../components/ExternalNavButtons';
import {Appear} from '../components/motion';

type Props = NativeStackScreenProps<RootStackParamList, 'TripActive'>;

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
    default:
      return t('trips.status.unknown');
  }
}

export const TripActiveScreen = ({navigation, route}: Props): React.JSX.Element => {
  const {t} = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const {tripId} = route.params;
  const trip = useTrip(tripId);
  const actions = useTripActions(tripId);
  const ensureAccepted = useEnsureTripAccepted(tripId);
  const ensureMutate = ensureAccepted.mutate;
  const setActiveTripId = useDispatchStore(s => s.setActiveTripId);
  const clearChat = useChatStore(s => s.clear);

  // Ubicación del conductor SOLO para pintar el mapa (degrada a null sin GPS nativo → sin pin).
  const driverLocation = useDriverLocation();

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
  const [childOpen, setChildOpen] = useState(false);
  const [childCode, setChildCode] = useState('');

  const status = trip.data ? parseTripStatus(trip.data.status) : 'UNKNOWN';

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
  const routeQuery = useTripRoute(tripId, isNavigating);
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

  const onStart = () => {
    if (trip.data?.childMode) {
      setChildOpen(true);
      return;
    }
    actions.start.mutate(undefined);
  };

  const onComplete = () => {
    actions.complete.mutate(undefined, {onSuccess: finishToDashboard});
  };

  // Entrada al chat con el pasajero (con badge de no leídos). Solo tiene sentido mientras el viaje
  // sigue activo; si terminó/canceló queda deshabilitada (no se conversa con un viaje cerrado).
  const chatTrailing = (
    <ChatButton
      tripId={tripId}
      accessibilityLabel={t('chat.openWithBadge')}
      disabled={!isTripActive(status)}
      onPress={() => navigation.navigate('Chat', {tripId})}
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
          action={{label: t('common.retry'), onPress: () => trip.refetch()}}
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
  const tripMetrics = `${t('trips.kilometers', {value: metersToKm(data.distanceMeters)})} · ${t('trips.minutes', {value: secondsToMinutes(data.durationSeconds)})}`;

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
                    <View style={[styles.statusIcon, {backgroundColor: theme.colors.surface, borderRadius: theme.radii.md}]}>
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
          }>
          <AppMap
            center={driverLocation ?? LIMA_CENTER}
            driver={driverLocation}
            origin={tripRoute?.origin}
            destination={tripRoute?.destination}
            waypoints={tripRoute?.waypoints}
            routeCoordinates={routeCoordinates}
            fitToRoute={Boolean(routeCoordinates && routeCoordinates.length >= 2)}
            interactive={false}
          />
        </MapShell>
      </View>

      {/* Sheet inferior: panel del pasajero + estado + acción principal de la FSM. */}
      <ScrollView
        style={[styles.sheet, {backgroundColor: theme.colors.bg}]}
        contentContainerStyle={[styles.sheetContent, {paddingBottom: insets.bottom + theme.spacing.xl}]}
        showsVerticalScrollIndicator={false}>
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
        </Appear>

        {data.childMode ? (
          <Banner tone="info" title={t('trips.childMode')} description={t('trips.childModeHint')} />
        ) : null}

        {/* Navegación turn-by-turn: lista desplegable de pasos + fallback a apps externas. El banner
            de la próxima maniobra ya vive sobre el mapa (prioridad). Solo cuando hay ruta. */}
        {isNavigating && tripRoute ? (
          <>
            <RouteStepsList steps={tripRoute.steps} totalDistanceMeters={tripRoute.distanceMeters} />
            <ExternalNavButtons destination={externalDestination} />
          </>
        ) : null}

        {/* Mientras se consigue la ruta de navegación, avisa de forma discreta. */}
        {isNavigating && routeQuery.isError ? (
          <Banner tone="warn" title={t('navigation.routeUnavailable')} />
        ) : null}

        {actionError ? (
          <Banner tone="danger" title={t('errors.generic')} description={toErrorMessage(actionError, t)} />
        ) : null}

        <Appear key={`actions-${status}`} style={styles.actions}>
          {confirming ? <Button label={t('trips.confirmingAssignment')} fullWidth loading disabled /> : null}
          {confirmFailed ? <Button label={t('common.retry')} fullWidth onPress={retryConfirm} /> : null}
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
            <Button label={t('trips.actions.start')} variant="safe" fullWidth loading={anyBusy} onPress={onStart} />
          ) : null}
          {status === 'IN_PROGRESS' ? (
            <Button label={t('trips.actions.complete')} variant="safe" fullWidth loading={anyBusy} onPress={onComplete} />
          ) : null}

          {status === 'COMPLETED' || status === 'CANCELLED' ? (
            <Button label={t('shift.dashboardTitle')} fullWidth onPress={finishToDashboard} />
          ) : null}

          {isTripActive(status) && status !== 'IN_PROGRESS' ? (
            <Button label={t('trips.actions.cancel')} variant="ghost" fullWidth onPress={() => setCancelOpen(true)} />
          ) : null}
        </Appear>
      </ScrollView>

      <BottomSheet
        visible={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={t('trips.cancelConfirmTitle')}
        footer={
          <View style={styles.sheetFooter}>
            <Button label={t('common.back')} variant="secondary" onPress={() => setCancelOpen(false)} />
            <Button
              label={t('trips.actions.cancel')}
              variant="danger"
              loading={actions.cancel.isPending}
              onPress={() =>
                actions.cancel.mutate(cancelReason.trim() || undefined, {onSuccess: finishToDashboard})
              }
            />
          </View>
        }>
        <Text variant="callout" color="inkMuted" style={styles.spacer}>
          {t('trips.cancelConfirmBody')}
        </Text>
        <TextField
          label={t('trips.cancelReasonLabel')}
          value={cancelReason}
          onChangeText={setCancelReason}
          multiline
        />
      </BottomSheet>

      <BottomSheet
        visible={childOpen}
        onClose={() => setChildOpen(false)}
        title={t('trips.childMode')}
        footer={
          <View style={styles.sheetFooter}>
            <Button label={t('common.cancel')} variant="secondary" onPress={() => setChildOpen(false)} />
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
        }>
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
  headerPad: {paddingHorizontal: 20},
  mapArea: {flex: 1},
  // Empuja el banner de estado por debajo del pill "EN VIVO" de MapShell (esquina superior izq.).
  statusBanner: {marginTop: 32},
  // Banner de maniobra: mismo respiro bajo el pill "EN VIVO".
  maneuverWrap: {marginTop: 32},
  statusRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  statusIcon: {width: 40, height: 40, alignItems: 'center', justifyContent: 'center'},
  flex: {flex: 1},
  sheet: {flexShrink: 0, maxHeight: '46%'},
  sheetContent: {paddingHorizontal: 20, paddingTop: 16, gap: 14},
  passengerRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  fareCol: {alignItems: 'flex-end'},
  statusPillRow: {flexDirection: 'row'},
  actions: {gap: 12, marginTop: 4},
  sheetFooter: {flexDirection: 'row', justifyContent: 'flex-end', gap: 12},
  spacer: {marginTop: 12},
});
