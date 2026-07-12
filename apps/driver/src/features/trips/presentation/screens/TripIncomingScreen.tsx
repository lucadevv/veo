import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import Animated, { Easing, FadeIn, SlideInDown } from 'react-native-reanimated';
import {
  Banner,
  Button,
  MapShell,
  SafeScreen,
  Skeleton,
  StatusPill,
  Text,
  useReducedMotion,
  useTheme,
} from '@veo/ui-kit';
import type { RootStackParamList } from '../../../../navigation/types';
import { useCountdownMs, toEpochMs } from '../../../../shared/presentation/hooks/useCountdownMs';
import { AppMap } from '../../../../shared/presentation/components/AppMap';
import { StateView } from '../../../../shared/presentation/components/StateView';
import { CountdownBadge } from '../../../../shared/presentation/components/CountdownBadge';
import { TripStatsCard } from '../../../../shared/presentation/components/TripStatsCard';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { formatPEN, metersToKm, secondsToMinutes } from '../../../../shared/presentation/format';
import { LIMA_CENTER } from '../../../../shared/utils/geo';
import {
  IconClock,
  IconNavigation,
  IconRoute,
} from '../../../../shared/presentation/icons';
import { useDispatchStore } from '../../../realtime/presentation/state/dispatchStore';
import { useAcceptOffer, useOffer, useRejectOffer } from '../hooks/useTrips';
import { Appear } from '../components/motion';

type Props = NativeStackScreenProps<RootStackParamList, 'TripIncoming'>;

/**
 * Oferta entrante (Midnight Motion): mapa de fondo atenuado + sheet inferior prominente con anillo
 * de cuenta atrás cian, tarifa estimada como foco y aceptar/rechazar. Pre-aceptación solo se muestran
 * tarifa estimada y distancia/duración (regla #5 de CLAUDE.md); los datos completos del pasajero
 * llegan tras aceptar. SOLO se transformó el layout/estilo: hooks, mutaciones y navegación intactos.
 */
export const TripIncomingScreen = ({ navigation, route }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const { matchId, tripId } = route.params;

  // Entrada destacada del sheet: sube desde abajo (curva drawer) o cae a fade con reduce-motion.
  const sheetEntering = reduced
    ? FadeIn.duration(theme.motion.duration.base)
    : SlideInDown.duration(theme.motion.duration.slow).easing(
        Easing.bezierFn(...theme.motion.easing.drawer),
      );

  const incomingOffer = useDispatchStore((s) => s.incomingOffer);
  const clearOffer = useDispatchStore((s) => s.clearOffer);
  const setActiveTripId = useDispatchStore((s) => s.setActiveTripId);

  // Fuente del resumen: la OFERTA (no `GET /trips/:id`). El conductor ofertado aún NO está asignado al
  // viaje, así que el detalle gateado por conductor-asignado daría 404 y rompía el match: la oferta ES la
  // autorización y ya trae el resumen de DECISIÓN (tarifa/distancia/duración/modo niño/origen/destino).
  const offer = useOffer(matchId);
  const acceptOffer = useAcceptOffer();
  const rejectOffer = useRejectOffer();

  const offerForMatch = incomingOffer?.matchId === matchId ? incomingOffer : undefined;
  const expiresAt = offerForMatch?.expiresAt;
  // ETA conductor→recojo (3er stat "A recojo" del frame): dato EFÍMERO del push de oferta, no del
  // `OfferView` REST (como el countdown). Puede faltar (dispatch lo omite si `maps.eta` no estuvo
  // disponible) → el stat degrada a "—" sin mentir "0 min".
  const pickupEtaSeconds = offerForMatch?.pickupEtaSeconds;
  // Reserva (viaje programado): se muestra un badge "Reservado". Si el evento no trajo la marca,
  // `scheduled` queda en falsy y no se renderiza nada (degrada con gracia).
  const scheduled = offerForMatch?.scheduled === true;
  // J2 · hook canónico único; el push FIXED trae `expiresAt` como ISO → epoch en el borde (toEpochMs).
  const secondsLeft = useCountdownMs(toEpochMs(expiresAt));
  const expired = Boolean(expiresAt) && secondsLeft <= 0;

  const onAccept = () => {
    acceptOffer.mutate(matchId, {
      onSuccess: () => {
        clearOffer();
        setActiveTripId(tripId);
        navigation.replace('TripActive', { tripId });
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

  // Oferta VENCIDA: salida limpia. NO pega `reject` al backend (la oferta ya expiró del lado dispatch;
  // rechazarla es un request inútil que además puede errorar). Solo limpia el estado local y vuelve.
  const onExpiredDismiss = () => {
    clearOffer();
    navigation.goBack();
  };

  return (
    <SafeScreen padded={false}>
      {/* Mapa de fondo atenuado: sin coordenadas reales pre-aceptación, centramos en Lima SIN pin.
          Regla #5 del conductor: pre-aceptación solo distancia + tarifa; el recojo/destino exactos son
          "datos completos" que se revelan POST-aceptación (en TripActive). No mostramos pins acá. */}
      <View style={styles.mapArea}>
        <MapShell>
          <AppMap center={LIMA_CENTER} interactive={false} />
        </MapShell>
        <View
          style={[styles.scrim, { backgroundColor: theme.colors.overlay }]}
          pointerEvents="none"
        />
        <View
          style={[styles.topBar, { top: insets.top + theme.spacing.sm }]}
          pointerEvents="box-none"
        >
          <StatusPill
            label={
              expired
                ? t('trips.incomingExpired')
                : t('trips.incomingExpires', { seconds: secondsLeft })
            }
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
            // OfferSheet (frame C/TripIncoming): superficie blanca sólida, esquinas superiores redondeadas,
            // sombra hacia arriba, flotando sobre el mapa Daylight Trust.
            backgroundColor: theme.colors.surface,
            borderTopLeftRadius: theme.radii['2xl'],
            borderTopRightRadius: theme.radii['2xl'],
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            borderLeftWidth: 1,
            borderRightWidth: 1,
            borderColor: theme.colors.border,
            paddingBottom: insets.bottom + theme.spacing.xl,
            ...theme.elevation.level3,
          },
        ]}
      >
        {/* J3 · SIN grabber falso: la oferta FIXED es un TAKEOVER full-screen (oferta directa, estilo Uber),
            NO un bottom-sheet arrastrable. El grabber decorativo implicaba draggability inexistente y hacía
            que la 1ra oferta pareciera el mismo sheet que la PUJA (CounterOfferSheet, ese SÍ es draggable).
            El handle real vive solo donde hay gesto real; acá el panel es fijo. */}
        {/* Grabber + TopRow (frame OfferSheet): "Nuevo viaje" a la izquierda + círculo countdown a la derecha. */}
        <View style={styles.grabberWrap}>
          <View style={[styles.grabber, { backgroundColor: theme.colors.borderStrong }]} />
        </View>
        <View style={styles.topRow}>
          <Text variant="title2">{t('trips.incomingTitle')}</Text>
          {!expired ? <CountdownBadge seconds={secondsLeft} /> : null}
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {offer.isLoading ? (
            <Skeleton height={140} />
          ) : offer.isError || !offer.data ? (
            <StateView
              title={t('errors.generic')}
              description={toErrorMessage(offer.error, t)}
              action={{ label: t('common.retry'), onPress: () => offer.refetch() }}
            />
          ) : (
            <>
              {/* Foco: tarifa estimada grande. */}
              <Appear style={styles.fareBlock} delay={40}>
                <Text variant="subhead" color="inkSubtle" align="center">
                  {t('trips.estimatedFare')}
                </Text>
                <Text variant="display" align="center" tabular>
                  {formatPEN(offer.data.fareCents)}
                </Text>
              </Appear>

              {/* Métricas de decisión (frame C/TripIncoming · bloque `Metrics`): 3 columnas ícono +
                  valor + label, separadas por divisores verticales. Distancia y Duración salen del
                  `OfferView`; "A recojo" (ETA conductor→recojo) del push efímero (store). Regla #5:
                  pre-aceptación solo distancia/tarifa/tiempos, ninguna dirección real. */}
              {/* Badges funcionales que el mockup happy-path omite pero el conductor necesita para decidir. */}
              {scheduled ? <StatusPill label={t('trips.scheduledBadge')} tone="brand" dot /> : null}
              {offer.data.passengerVerified ? (
                <StatusPill label={t('trips.passengerVerified')} tone="success" dot />
              ) : null}

              {/* Métricas de decisión → componente canónico TripStatsCard (antes inline con .map). */}
              <Appear delay={120}>
                <TripStatsCard
                  stats={[
                    {
                      key: 'distance',
                      Icon: IconRoute,
                      label: t('trips.distance'),
                      value: t('trips.kilometers', { value: metersToKm(offer.data.distanceMeters) }),
                    },
                    {
                      key: 'duration',
                      Icon: IconClock,
                      label: t('trips.duration'),
                      value: t('trips.minutes', {
                        value: secondsToMinutes(offer.data.durationSeconds),
                      }),
                    },
                    {
                      key: 'pickupEta',
                      Icon: IconNavigation,
                      label: t('trips.pickupEta'),
                      value:
                        pickupEtaSeconds && pickupEtaSeconds > 0
                          ? t('trips.minutes', { value: secondsToMinutes(pickupEtaSeconds) })
                          : '—',
                    },
                  ]}
                />
              </Appear>

              {/* BE-2 · solicitudes especiales (mascota/equipaje/silla): el conductor las ve para decidir.
                  Reusa las etiquetas i18n del marketplace de pujas (trips.bid.special.*). */}
              {offer.data.specialRequests.length > 0 ? (
                <Appear delay={160} style={styles.specials}>
                  {offer.data.specialRequests.map((req) => (
                    <StatusPill
                      key={req}
                      label={t(`trips.bid.special.${req}`, { defaultValue: req })}
                      tone="neutral"
                    />
                  ))}
                </Appear>
              ) : null}

              {offer.data.childMode ? (
                <Banner
                  tone="info"
                  title={t('trips.childMode')}
                  description={t('trips.childModeHint')}
                />
              ) : null}
            </>
          )}

          {acceptOffer.isError ? (
            <Banner
              tone="danger"
              title={t('errors.generic')}
              description={toErrorMessage(acceptOffer.error, t)}
            />
          ) : null}
          {rejectOffer.isError ? (
            <Banner
              tone="danger"
              title={t('errors.generic')}
              description={toErrorMessage(rejectOffer.error, t)}
            />
          ) : null}
          {expired ? <Banner tone="danger" title={t('trips.incomingExpired')} /> : null}
        </ScrollView>

        {/* Acciones: vencida → una sola salida limpia ("Volver"); viva → rechazar + aceptar. */}
        <View style={styles.actions}>
          {expired ? (
            <Button
              label={t('trips.incomingDismiss')}
              variant="accent"
              fullWidth
              onPress={onExpiredDismiss}
            />
          ) : (
            <>
              <Button
                label={t('trips.reject')}
                variant="secondary"
                loading={rejectOffer.isPending}
                onPress={onReject}
                style={styles.rejectBtn}
              />
              <Button
                label={t('trips.accept')}
                variant="accent"
                fullWidth
                disabled={acceptOffer.isPending}
                loading={acceptOffer.isPending}
                onPress={onAccept}
                style={styles.acceptBtn}
              />
            </>
          )}
        </View>
      </Animated.View>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  mapArea: { flex: 1 },
  scrim: { ...StyleSheet.absoluteFill },
  topBar: { position: 'absolute', left: 20, right: 20, alignItems: 'center' },
  sheet: { paddingHorizontal: 20, paddingTop: 12, maxHeight: '72%' },
  grabberWrap: { alignItems: 'center', paddingBottom: 8 },
  grabber: { width: 40, height: 5, borderRadius: 999 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  scroll: { marginTop: 16 },
  scrollContent: { gap: 16, paddingBottom: 8 },
  fareBlock: { gap: 2 },
  specials: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16 },
  rejectBtn: { width: 120 },
  acceptBtn: { flex: 1 },
});
