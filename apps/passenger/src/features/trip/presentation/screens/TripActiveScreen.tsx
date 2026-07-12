import type {GeoPoint} from '@veo/api-client';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  Banner,
  BottomSheet,
  Button,
  Card,
  DriverCard,
  IconButton,
  MapShell,
  RoutePin,
  SafeScreen,
  SosButton,
  StatusPill,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import React, {useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {ScrollView, Share, StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {AppMap} from '../../../../shared/presentation/components/AppMap';
import {
  ErrorState,
  LoadingState,
} from '../../../../shared/presentation/components/ScreenStates';
import {decodePolylineToCoordinates} from '../../../../shared/utils/polyline';
import {
  formatDurationMinutes,
  formatPEN,
} from '../../../../shared/utils/format';
import type {RootStackParamList} from '../../../../navigation/types';
import {usePanicAutoTrigger} from '../../../../core/panic/usePanicAutoTrigger';
import {CabinVideoPanel} from '../components/CabinVideoPanel';
import {LiveBadge} from '../components/LiveBadge';
import {TripStatusPill} from '../components/TripStatusPill';
import {EnterView} from '../components/motion';
import {IconChat, IconRoute, IconShare} from '../components/icons';
import {usePassengerTripSocket} from '../../../../core/realtime/usePassengerTripSocket';
import {useActiveTripStore} from '../stores/activeTripStore';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Params = RouteProp<RootStackParamList, 'TripActive'>;

/**
 * Viaje activo (Midnight Motion): estado en vivo (detalle REST + socket `/passenger`), tarjeta del
 * conductor real, ruta y ubicación del conductor en el mapa oscuro, botón SOS flotante y acciones
 * (cancelar, cambiar destino, pánico). Mientras no hay conductor asignado, muestra un radar elegante
 * de "buscando conductor" (sin inventar un conductor). Al completarse, ofrece pagar y calificar.
 *
 * ESTADO (deuda técnica acotada): esta pantalla es la vista de viaje en vivo LEGACY. El "Mis Viajes"
 * (historial) YA NO la usa: un viaje vivo se re-entra por el flujo unificado (sheet del Home), y uno
 * terminal abre `TripDetail`. PERO sigue VIVA porque un DEEP-LINK de push aterriza aquí (`data.screen:
 * 'TripActive'` o el fallback con `tripId`, ver deepLink.ts). No se elimina para no romper ese camino.
 */
export function TripActiveScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const {params} = useRoute<Params>();
  const {tripId} = params;

  const queryClient = useQueryClient();
  const tripRepository = useDependency(TOKENS.tripRepository);
  const cancelTrip = useDependency(TOKENS.cancelTripUseCase);
  const changeDestination = useDependency(TOKENS.changeDestinationUseCase);
  const shareTrip = useDependency(TOKENS.shareTripUseCase);
  const revokeShare = useDependency(TOKENS.revokeShareUseCase);
  const history = useDependency(TOKENS.tripHistoryRepository);

  // Enlace de seguimiento ACTIVO de la sesión (kill-switch R3): el id se RETIENE al crear el enlace
  // para poder revocarlo (antes se descartaba → endpoint de revoke inalcanzable). Vive en el store del
  // viaje activo (sobrevive al desmontaje del sheet); `clear()` del viaje lo arrastra (lifecycle).
  const activeShareId = useActiveTripStore(s => s.activeShareId);
  const shareExpiresAt = useActiveTripStore(s => s.shareExpiresAt);
  const setActiveShare = useActiveTripStore(s => s.setActiveShare);
  const clearShare = useActiveTripStore(s => s.clearShare);

  const live = usePassengerTripSocket(tripId);

  // No leídos del chat: mensajes entrantes del conductor recibidos en esta pantalla y aún no abiertos.
  // Al entrar al chat los marcamos como consumidos (drena el acumulado del socket y resetea el badge).
  const unreadCount = live.incomingMessages.length;
  const openChat = (): void => {
    live.acknowledgeMessages(live.incomingMessages.map(message => message.id));
    navigation.navigate('Chat', {tripId});
  };

  const tripQuery = useQuery({
    queryKey: ['trip', tripId, 'active'],
    queryFn: () => tripRepository.getActiveTrip(tripId),
    refetchInterval: live.ended ? false : 15_000,
  });

  // Detección NATIVA de pánico (triple volumen): armada SOLO mientras el viaje siga vivo. Se desarma en
  // CUALQUIER estado terminal — incluido un FAILED/CANCELLED visto solo por el poll REST (socket caído, sin
  // el evento `trip:ended` que prende `live.ended`): si no, el detector nativo quedaría armado en un viaje
  // muerto y un triple-volumen accidental dispararía un FALSO pánico (SMS a contactos + alerta central).
  const panicStatus = live.status ?? tripQuery.data?.status ?? null;
  const tripIsOver =
    live.ended ||
    panicStatus === 'FAILED' ||
    panicStatus === 'CANCELLED' ||
    panicStatus === 'COMPLETED';
  usePanicAutoTrigger(tripId, !tripIsOver);

  // PUJA · el conductor canceló pre-recojo (B1 · status REASSIGNING): el board se reabre en el server.
  // Llevamos al pasajero a la pantalla de Reasignación ("tu conductor canceló, buscando otro"), que
  // explica el estado y continúa al tablero de ofertas. Reacciona al estado EFECTIVO (socket o, si cayó,
  // el poll REST) para no quedar colgado si el socket se cae justo en el REASSIGNING.
  useEffect(() => {
    if ((live.status ?? tripQuery.data?.status) === 'REASSIGNING') {
      navigation.replace('Reassign', {tripId});
    }
  }, [live.status, tripQuery.data?.status, navigation, tripId]);

  // Snapshot local (origen/destino/polyline) que el bff devolvió al crear el viaje.
  const snapshot = useMemo(
    () => history.list().find(item => item.id === tripId),
    [history, tripId],
  );

  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [picking, setPicking] = useState(false);
  const [newDestination, setNewDestination] = useState<GeoPoint | null>(null);
  // Hoja de confirmación del kill-switch + banner de éxito (estado D, "ya dejaste de compartir").
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [justRevoked, setJustRevoked] = useState(false);

  // Countdown "Expira en …" del enlace activo (estado C). Se re-renderiza por minuto: el segundo a
  // segundo es ruido visual para un TTL de hasta 2h. `null` si no hay enlace o ya venció.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!shareExpiresAt) return undefined;
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [shareExpiresAt]);
  const shareCountdown = useMemo(() => {
    if (!shareExpiresAt) return null;
    const remainingMs = new Date(shareExpiresAt).getTime() - nowMs;
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
    const totalMinutes = Math.ceil(remainingMs / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
  }, [shareExpiresAt, nowMs]);

  const cancelMutation = useMutation({
    mutationFn: () => cancelTrip.execute(tripId, reason.trim() || undefined),
    onSuccess: trip => {
      history.record(trip);
      setCancelOpen(false);
      queryClient.invalidateQueries({queryKey: ['trip', tripId, 'active']});
    },
  });

  const changeMutation = useMutation({
    mutationFn: () =>
      changeDestination.execute(tripId, newDestination as GeoPoint),
    onSuccess: trip => {
      history.record(trip);
      setPicking(false);
      setNewDestination(null);
      queryClient.invalidateQueries({queryKey: ['trip', tripId, 'active']});
    },
  });

  // Compartir viaje con la familia: crea el enlace público firmado y abre la hoja nativa de
  // compartir. Errores de red o de la hoja se capturan en la mutación (sin unhandled rejection).
  // RETENEMOS el enlace (setActiveShare) ANTES de abrir la hoja nativa: el link YA existe en el server,
  // así el botón "Dejar de compartir" aparece aunque el usuario cancele el sheet nativo (kill-switch R3).
  const shareMutation = useMutation({
    mutationFn: async () => {
      const link = await shareTrip.execute(tripId);
      setActiveShare(link.shareId, link.expiresAt);
      setJustRevoked(false);
      await Share.share({
        title: t('trip.shareTitle'),
        message: t('trip.shareMessage', {url: link.url}),
        url: link.url,
      });
    },
  });

  // Kill-switch: revoca el enlace de la sesión actual (la página pública deja de servir la ubicación al
  // instante). Idempotente en el server. En éxito: olvida el enlace (vuelve al estado A) + cierra la hoja
  // + muestra el banner de confirmación. En error: la hoja NO se cierra y muestra un banner de error.
  const revokeMutation = useMutation({
    mutationFn: () => {
      if (!activeShareId) throw new Error('no-active-share');
      return revokeShare.execute(activeShareId);
    },
    onSuccess: () => {
      clearShare();
      setRevokeOpen(false);
      setJustRevoked(true);
    },
  });

  if (tripQuery.isLoading) {
    return (
      <SafeScreen>
        <LoadingState />
      </SafeScreen>
    );
  }

  if (tripQuery.isError || !tripQuery.data) {
    return (
      <SafeScreen>
        <ErrorState onRetry={() => tripQuery.refetch()} />
      </SafeScreen>
    );
  }

  const trip = tripQuery.data;
  const status = live.status ?? trip.status;
  const isInProgress = status === 'IN_PROGRESS';
  const isCompleted = status === 'COMPLETED';
  const isCancelled = status === 'CANCELLED';
  // FAILED (watchdog cerró un viaje abandonado) = terminal SIN completar: como CANCELLED, sin acciones
  // de viaje vivo. `isAborted` agrupa ambos (terminado sin cobro) para ocultar SOS/chat/acciones.
  const isFailed = status === 'FAILED';
  const isAborted = isCancelled || isFailed;
  const etaMinutes =
    live.etaSeconds != null ? formatDurationMinutes(live.etaSeconds) : null;

  const routeCoordinates = decodePolylineToCoordinates(snapshot?.routePolyline);
  const destination = newDestination ?? snapshot?.destination ?? null;
  const hasDriver = Boolean(trip.driver);

  return (
    <SafeScreen padded={false}>
      <View style={styles.mapArea}>
        <MapShell live={!live.ended}>
          <AppMap
            origin={snapshot?.origin ?? null}
            destination={destination}
            waypoints={snapshot?.waypoints}
            driver={live.driverLocation ?? null}
            routeCoordinates={
              routeCoordinates.length > 1 ? routeCoordinates : undefined
            }
            fitToRoute={!picking && routeCoordinates.length > 1}
            center={snapshot?.origin ?? null}
            interactive
            onPress={picking ? point => setNewDestination(point) : undefined}
          />
        </MapShell>

        {/* Botón SOS flotante: disponible durante todo el viaje activo. */}
        {!isCompleted && !isAborted ? (
          <View
            style={[
              styles.sos,
              {top: insets.top + theme.spacing.sm, right: theme.spacing.lg},
            ]}>
            <SosButton
              size={56}
              onPress={() => navigation.navigate('Panic', {tripId})}
            />
          </View>
        ) : null}

        {/* Pill "EN VIVO" (top-center del mapa): seguimiento en vivo mientras el viaje no terminó.
            Badge premium glass-dark dedicado con dot success pulsante (respeta reduce-motion). */}
        {!isCompleted && !isAborted ? (
          <View
            style={[styles.livePill, {top: insets.top + theme.spacing.sm}]}
            pointerEvents="none">
            <LiveBadge />
          </View>
        ) : null}

        {/* Chat con el conductor: visible al haber conductor asignado y viaje activo. Badge de no leídos. */}
        {hasDriver && !isCompleted && !isAborted ? (
          <View
            style={[
              styles.chat,
              {top: insets.top + theme.spacing.sm, left: theme.spacing.lg},
            ]}>
            <IconButton
              accessibilityLabel={t('chat.open')}
              variant="surface"
              onPress={openChat}
              icon={<IconChat color={theme.colors.ink} size={20} />}
            />
            {unreadCount > 0 ? (
              <View
                style={[
                  styles.badge,
                  {
                    backgroundColor: theme.colors.accent,
                    borderColor: theme.colors.bg,
                  },
                ]}
                accessibilityLabel={t('chat.open')}>
                <Text variant="caption" color="onAccent" tabular>
                  {unreadCount > 9 ? '9+' : unreadCount}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>

      <ScrollView
        style={[styles.sheet, {backgroundColor: theme.colors.bg}]}
        contentContainerStyle={{
          padding: theme.spacing.xl,
          gap: theme.spacing.md,
        }}
        showsVerticalScrollIndicator={false}>
        <View style={styles.statusRow}>
          <TripStatusPill status={status} />
          {etaMinutes != null && !isCompleted && !isAborted ? (
            <Text variant="bodyStrong" tabular>
              {t('trip.etaMinutes', {minutes: etaMinutes})}
            </Text>
          ) : null}
        </View>

        {hasDriver ? (
          <EnterView>
            <DriverCard
              // SEGURIDAD: el nombre real del conductor (del backend) para confirmar a quién se sube; cae
              // a "Conductor" genérico solo si el backend aún no lo tiene (degradación honesta).
              name={trip.driver?.name ?? t('trip.driver')}
              rating={trip.driver?.rating ?? undefined}
              vehicle={
                trip.vehicle
                  ? `${trip.vehicle.make} ${trip.vehicle.model} · ${trip.vehicle.color}`
                  : undefined
              }
              plate={trip.vehicle?.plate}
              eta={
                etaMinutes != null
                  ? t('trip.etaMinutes', {minutes: etaMinutes})
                  : undefined
              }
            />
          </EnterView>
        ) : !isCompleted && !isAborted ? (
          <EnterView>
            <Card variant="outlined" padding="lg">
              <View style={[styles.searching, {gap: theme.spacing.md}]}>
                <RoutePin variant="user" pulse size={20} />
                <View style={styles.flex}>
                  <Text variant="bodyStrong">{t('trip.searchingTitle')}</Text>
                  <Text variant="footnote" color="inkMuted">
                    {t('trip.searchingBody')}
                  </Text>
                </View>
              </View>
            </Card>
          </EnterView>
        ) : null}

        <Card variant="outlined" padding="lg">
          <View style={styles.fareRow}>
            <Text variant="callout" color="inkMuted">
              {t('home.fare')}
            </Text>
            <Text variant="title3" tabular>
              {formatPEN(trip.fareCents)}
            </Text>
          </View>
        </Card>

        {/* Indicador de cámara del habitáculo. En curso → permite abrirla a pantalla completa (CameraLive). */}
        <CabinVideoPanel
          tripId={tripId}
          active={isInProgress}
          onOpenFullscreen={
            isInProgress
              ? () => navigation.navigate('CameraLive', {tripId})
              : undefined
          }
        />

        {isCancelled ? (
          <Banner tone="warn" title={t('tripStatus.CANCELLED')} />
        ) : null}
        {isFailed ? (
          <Banner
            tone="danger"
            title={t('tripStatus.FAILED')}
            description={t('trip.failedBody')}
          />
        ) : null}

        {isCompleted ? (
          <View style={{gap: theme.spacing.sm}}>
            <Button
              label={t('trip.payNow')}
              variant="primary"
              fullWidth
              onPress={() =>
                navigation.navigate('Payment', {
                  tripId,
                  amountCents: trip.fareCents,
                  ...(trip.driver ? {driverId: trip.driver.id} : {}),
                })
              }
            />
            {trip.driver ? (
              <Button
                label={t('trip.rateNow')}
                variant="secondary"
                fullWidth
                onPress={() =>
                  navigation.navigate('Rating', {
                    tripId,
                    driverId: trip.driver!.id,
                  })
                }
              />
            ) : null}
          </View>
        ) : !isAborted ? (
          <View style={{gap: theme.spacing.sm}}>
            {picking ? (
              <>
                <Banner
                  tone="info"
                  title={t('trip.changeDestinationTitle')}
                  description={t('trip.changeDestinationBody')}
                />
                {/* Fallo del cambio de destino: antes el toque de "Confirmar" quedaba mudo. Banner
                    honesto como las hermanas (cancelar/compartir); el mismo botón reintenta. */}
                {changeMutation.isError ? (
                  <Banner
                    tone="danger"
                    title={t('trip.changeDestinationError')}
                  />
                ) : null}
                <Button
                  label={t('actions.confirm')}
                  variant="primary"
                  fullWidth
                  loading={changeMutation.isPending}
                  disabled={!newDestination || changeMutation.isPending}
                  onPress={() => changeMutation.mutate()}
                />
                <Button
                  label={t('actions.cancel')}
                  variant="ghost"
                  fullWidth
                  onPress={() => {
                    setPicking(false);
                    setNewDestination(null);
                  }}
                />
              </>
            ) : (
              <>
                <Button
                  label={t('trip.changeDestination')}
                  variant="secondary"
                  fullWidth
                  leftIcon={<IconRoute color={theme.colors.ink} size={18} />}
                  onPress={() => setPicking(true)}
                />
                {/* Compartir viaje con la familia: visible mientras el viaje no haya terminado.
                    Estado A (sin enlace) → botón de compartir; estado C (enlace activo) → pill "en vivo"
                    + countdown + botón danger de kill-switch. El estado B (generando) es el `loading`. */}
                {activeShareId == null ? (
                  <>
                    <Button
                      label={t('trip.share')}
                      variant="secondary"
                      fullWidth
                      leftIcon={
                        <IconShare color={theme.colors.ink} size={18} />
                      }
                      loading={shareMutation.isPending}
                      disabled={shareMutation.isPending}
                      onPress={() => shareMutation.mutate()}
                    />
                    {shareMutation.isError ? (
                      <Banner tone="danger" title={t('trip.shareError')} />
                    ) : null}
                    {justRevoked ? (
                      <Banner
                        tone="success"
                        title={t('trip.shareRevokedBanner')}
                      />
                    ) : null}
                  </>
                ) : (
                  <Card variant="outlined" padding="lg">
                    <View style={{gap: theme.spacing.sm}}>
                      <StatusPill
                        label={t('trip.sharingActive')}
                        tone="accent"
                        live
                      />
                      {shareCountdown != null ? (
                        <Text variant="footnote" color="inkMuted">
                          {t('trip.shareExpiresIn', {
                            countdown: shareCountdown,
                          })}
                        </Text>
                      ) : null}
                      <Button
                        label={t('trip.revokeShare')}
                        variant="danger"
                        fullWidth
                        onPress={() => {
                          revokeMutation.reset();
                          setRevokeOpen(true);
                        }}
                      />
                    </View>
                  </Card>
                )}
              </>
            )}
            <Button
              label={t('trip.cancel')}
              variant="ghost"
              fullWidth
              onPress={() => setCancelOpen(true)}
            />
          </View>
        ) : null}
      </ScrollView>

      <BottomSheet
        visible={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={t('trip.cancelTitle')}
        footer={
          <View style={{gap: theme.spacing.sm}}>
            <Button
              label={t('trip.cancel')}
              variant="danger"
              fullWidth
              loading={cancelMutation.isPending}
              onPress={() => cancelMutation.mutate()}
            />
            <Button
              label={t('trip.keepTrip')}
              variant="ghost"
              fullWidth
              onPress={() => setCancelOpen(false)}
            />
          </View>
        }>
        <View style={{gap: theme.spacing.md}}>
          <Text variant="callout" color="inkMuted">
            {t('trip.cancelBody')}
          </Text>
          {cancelMutation.isError ? (
            <Banner tone="danger" title={t('states.errorBody')} />
          ) : null}
          <TextField
            label={t('trip.cancelReasonLabel')}
            value={reason}
            onChangeText={setReason}
            multiline
          />
        </View>
      </BottomSheet>

      {/* Confirmación del kill-switch (espeja el patrón "Cancelar viaje"): footer danger/ghost. En error
          la hoja NO se cierra (banner danger); el éxito la cierra desde `revokeMutation.onSuccess`. */}
      <BottomSheet
        visible={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        title={t('trip.revokeShareTitle')}
        footer={
          <View style={{gap: theme.spacing.sm}}>
            <Button
              label={t('trip.revokeShareConfirm')}
              variant="danger"
              fullWidth
              loading={revokeMutation.isPending}
              onPress={() => revokeMutation.mutate()}
            />
            <Button
              label={t('trip.revokeShareKeep')}
              variant="ghost"
              fullWidth
              onPress={() => setRevokeOpen(false)}
            />
          </View>
        }>
        <View style={{gap: theme.spacing.md}}>
          <Text variant="callout" color="inkMuted">
            {t('trip.revokeShareBody')}
          </Text>
          {revokeMutation.isError ? (
            <Banner tone="danger" title={t('trip.revokeShareError')} />
          ) : null}
        </View>
      </BottomSheet>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  mapArea: {flex: 1},
  // El MAPA manda en el viaje activo (regla del dueño: "mapa arriba del sheet"). Antes el sheet (1.3)
  // se comía la pantalla y el mapa quedaba chico; igualamos para que el mapa recupere protagonismo.
  sheet: {flex: 1},
  sos: {position: 'absolute'},
  chat: {position: 'absolute'},
  livePill: {position: 'absolute', left: 0, right: 0, alignItems: 'center'},
  badge: {
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
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  searching: {flexDirection: 'row', alignItems: 'center'},
  fareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  flex: {flex: 1},
});
