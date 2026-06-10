import React, {useEffect, useMemo, useRef, useState} from 'react';
import {ScrollView, StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import Animated, {Easing, FadeIn, SlideInDown} from 'react-native-reanimated';
import {Banner, Button, MapShell, SafeScreen, Skeleton, StatusPill, Text, useReducedMotion, useTheme} from '@veo/ui-kit';
import type {RootStackParamList} from '../../../../navigation/types';
import {AppMap} from '../../../../shared/presentation/components/AppMap';
import {StateView} from '../../../../shared/presentation/components/StateView';
import {toErrorMessage} from '../../../../shared/presentation/errors';
import {formatPEN, metersToKm, secondsToMinutes} from '../../../../shared/presentation/format';
import {LIMA_CENTER} from '../../../../shared/utils/geo';
import {useDispatchStore} from '../../../realtime/presentation/state/dispatchStore';
import {useAcceptOffer, useRejectOffer, useTrip} from '../hooks/useTrips';
import {CountdownRing} from '../components/CountdownRing';
import {Appear, Pulse} from '../components/motion';

type Props = NativeStackScreenProps<RootStackParamList, 'TripIncoming'>;

/** Segundos restantes hasta `expiresAt` (>= 0). */
function useCountdown(expiresAt: string | undefined): number {
  const target = useMemo(() => (expiresAt ? new Date(expiresAt).getTime() : 0), [expiresAt]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!target) {
      return;
    }
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [target]);
  if (!target) {
    return 0;
  }
  return Math.max(0, Math.ceil((target - now) / 1000));
}

/**
 * Oferta entrante (Midnight Motion): mapa de fondo atenuado + sheet inferior prominente con anillo
 * de cuenta atrás cian, tarifa estimada como foco y aceptar/rechazar. Pre-aceptación solo se muestran
 * tarifa estimada y distancia/duración (regla #5 de CLAUDE.md); los datos completos del pasajero
 * llegan tras aceptar. SOLO se transformó el layout/estilo: hooks, mutaciones y navegación intactos.
 */
export const TripIncomingScreen = ({navigation, route}: Props): React.JSX.Element => {
  const {t} = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const {matchId, tripId} = route.params;

  // Entrada destacada del sheet: sube desde abajo (curva drawer) o cae a fade con reduce-motion.
  const sheetEntering = reduced
    ? FadeIn.duration(theme.motion.duration.base)
    : SlideInDown.duration(theme.motion.duration.slow).easing(Easing.bezierFn(...theme.motion.easing.drawer));

  const incomingOffer = useDispatchStore(s => s.incomingOffer);
  const clearOffer = useDispatchStore(s => s.clearOffer);
  const setActiveTripId = useDispatchStore(s => s.setActiveTripId);

  const trip = useTrip(tripId);
  const acceptOffer = useAcceptOffer();
  const rejectOffer = useRejectOffer();

  const offerForMatch = incomingOffer?.matchId === matchId ? incomingOffer : undefined;
  const expiresAt = offerForMatch?.expiresAt;
  // Reserva (viaje programado): se muestra un badge "Reservado". Si el evento no trajo la marca,
  // `scheduled` queda en falsy y no se renderiza nada (degrada con gracia).
  const scheduled = offerForMatch?.scheduled === true;
  const secondsLeft = useCountdown(expiresAt);
  const expired = Boolean(expiresAt) && secondsLeft <= 0;

  // Fracción real del anillo: el mayor valor observado del countdown hace de denominador (la ventana
  // de respuesta), sin inventar un total fijo. Empieza en 1 y decrece con el tiempo restante.
  const maxSecondsRef = useRef(0);
  if (secondsLeft > maxSecondsRef.current) {
    maxSecondsRef.current = secondsLeft;
  }
  const progress = maxSecondsRef.current > 0 ? secondsLeft / maxSecondsRef.current : 0;

  const onAccept = () => {
    acceptOffer.mutate(matchId, {
      onSuccess: () => {
        clearOffer();
        setActiveTripId(tripId);
        navigation.replace('TripActive', {tripId});
      },
    });
  };

  const onReject = () => {
    rejectOffer.mutate(matchId, {
      onSuccess: () => {
        clearOffer();
        navigation.goBack();
      },
    });
  };

  return (
    <SafeScreen padded={false}>
      {/* Mapa de fondo atenuado: sin coordenadas reales pre-aceptación, centramos en Lima sin pin. */}
      <View style={styles.mapArea}>
        <MapShell>
          <AppMap center={LIMA_CENTER} interactive={false} />
        </MapShell>
        <View style={[styles.scrim, {backgroundColor: theme.colors.overlay}]} pointerEvents="none" />
        <View style={[styles.topBar, {top: insets.top + theme.spacing.sm}]} pointerEvents="box-none">
          <StatusPill
            label={expired ? t('trips.incomingExpired') : t('trips.incomingExpires', {seconds: secondsLeft})}
            tone={expired ? 'danger' : 'warn'}
            live={!expired}
            dot
          />
        </View>
      </View>

      {/* Sheet inferior prominente con la oferta. */}
      <Animated.View
        entering={sheetEntering}
        style={[
          styles.sheet,
          {
            backgroundColor: theme.colors.surface,
            borderTopLeftRadius: theme.radii.xl,
            borderTopRightRadius: theme.radii.xl,
            paddingBottom: insets.bottom + theme.spacing.xl,
            ...theme.elevation.level3,
          },
        ]}>
        <View style={[styles.grabber, {backgroundColor: theme.colors.borderStrong}]} />

        <View style={styles.ringWrap}>
          {/* Anillo de atención cian: ping radar mientras la oferta sigue vigente. */}
          <View style={styles.ringPulseWrap} pointerEvents="none">
            <Pulse
              active={!expired}
              period={1400}
              minOpacity={0}
              maxOpacity={0.5}
              maxScale={1.35}
              style={[styles.ringPulse, {borderColor: theme.colors.accent}]}>
              {null}
            </Pulse>
          </View>
          <CountdownRing seconds={secondsLeft} progress={progress} expired={expired} />
          <Text variant="title2" align="center" style={styles.title}>
            {t('trips.incomingTitle')}
          </Text>
          {scheduled ? (
            <StatusPill label={t('trips.scheduledBadge')} tone="brand" dot />
          ) : null}
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}>
          {trip.isLoading ? (
            <Skeleton height={140} />
          ) : trip.isError || !trip.data ? (
            <StateView
              title={t('errors.generic')}
              description={toErrorMessage(trip.error, t)}
              action={{label: t('common.retry'), onPress: () => trip.refetch()}}
            />
          ) : (
            <>
              {/* Foco: tarifa estimada grande. */}
              <Appear style={styles.fareBlock} delay={40}>
                <Text variant="subhead" color="inkMuted" align="center">
                  {t('trips.estimatedFare')}
                </Text>
                <Text variant="display" align="center" tabular>
                  {formatPEN(trip.data.fareCents)}
                </Text>
              </Appear>

              {/* Resumen de ruta: motivo recojo→destino (sin direcciones reales en el contrato) con
                  los datos disponibles: distancia y duración. No se inventan direcciones. */}
              <Appear
                delay={120}
                style={[styles.routeCard, {backgroundColor: theme.colors.surfaceElevated, borderRadius: theme.radii.lg}]}>
                <View style={styles.rail}>
                  <View style={[styles.dot, {backgroundColor: theme.colors.accent}]} />
                  <View style={[styles.connector, {backgroundColor: theme.colors.border}]} />
                  <View style={[styles.dot, {backgroundColor: theme.colors.inkSubtle}]} />
                </View>
                <View style={styles.routeMetrics}>
                  <View style={styles.metricRow}>
                    <Text variant="footnote" color="inkMuted">
                      {t('trips.distance')}
                    </Text>
                    <Text variant="bodyStrong" tabular>
                      {t('trips.kilometers', {value: metersToKm(trip.data.distanceMeters)})}
                    </Text>
                  </View>
                  <View style={styles.metricRow}>
                    <Text variant="footnote" color="inkMuted">
                      {t('trips.duration')}
                    </Text>
                    <Text variant="bodyStrong" tabular>
                      {t('trips.minutes', {value: secondsToMinutes(trip.data.durationSeconds)})}
                    </Text>
                  </View>
                </View>
              </Appear>

              {trip.data.childMode ? (
                <Banner tone="info" title={t('trips.childMode')} description={t('trips.childModeHint')} />
              ) : null}
            </>
          )}

          {acceptOffer.isError ? (
            <Banner tone="danger" title={t('errors.generic')} description={toErrorMessage(acceptOffer.error, t)} />
          ) : null}
          {rejectOffer.isError ? (
            <Banner tone="danger" title={t('errors.generic')} description={toErrorMessage(rejectOffer.error, t)} />
          ) : null}
          {expired ? <Banner tone="danger" title={t('trips.incomingExpired')} /> : null}
        </ScrollView>

        {/* Acciones: rechazar (ghost, secundario) + aceptar (accent, dominante). */}
        <View style={styles.actions}>
          <Button
            label={t('trips.reject')}
            variant="ghost"
            loading={rejectOffer.isPending}
            onPress={onReject}
            style={styles.rejectBtn}
          />
          <Button
            label={t('trips.accept')}
            variant="accent"
            fullWidth
            disabled={expired || acceptOffer.isPending}
            loading={acceptOffer.isPending}
            onPress={onAccept}
            style={styles.acceptBtn}
          />
        </View>
      </Animated.View>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  mapArea: {flex: 1},
  scrim: {...StyleSheet.absoluteFill},
  topBar: {position: 'absolute', left: 20, right: 20, alignItems: 'center'},
  sheet: {paddingHorizontal: 20, paddingTop: 10, maxHeight: '64%'},
  grabber: {alignSelf: 'center', width: 40, height: 5, borderRadius: 999, marginBottom: 8},
  ringWrap: {alignItems: 'center', gap: 8, marginTop: 4},
  ringPulseWrap: {position: 'absolute', top: 0, width: 104, height: 104, alignItems: 'center', justifyContent: 'center'},
  ringPulse: {width: 104, height: 104, borderRadius: 52, borderWidth: 2},
  title: {marginTop: 4},
  scroll: {marginTop: 16},
  scrollContent: {gap: 16, paddingBottom: 8},
  fareBlock: {gap: 2},
  routeCard: {flexDirection: 'row', alignItems: 'center', gap: 16, padding: 16},
  rail: {alignItems: 'center', alignSelf: 'stretch', paddingVertical: 4},
  dot: {width: 12, height: 12, borderRadius: 999},
  connector: {width: 2, flex: 1, minHeight: 24, marginVertical: 4},
  routeMetrics: {flex: 1, gap: 12},
  metricRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  actions: {flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16},
  rejectBtn: {flex: 0},
  acceptBtn: {flex: 1},
});
