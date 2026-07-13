import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Banner, Button, Skeleton, Text, useTheme } from '@veo/ui-kit';
import {
  formatPEN,
  metersToKm,
  secondsToMinutes,
} from '../../../../shared/presentation/format';
import { useCountdownMs, toEpochMs } from '../../../../shared/presentation/hooks/useCountdownMs';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { useDispatchStore, type IncomingOffer } from '../../../realtime/presentation/state/dispatchStore';
import { useAcceptOffer, useOffer, useRejectOffer } from '../hooks/useTrips';

interface Props {
  offer: IncomingOffer;
  /** Aceptada la oferta → el dashboard navega al viaje activo (el store ya quedó con activeTripId). */
  onAccepted: (tripId: string) => void;
}

/**
 * Oferta FIXED ("Nuevo viaje") como CARD editorial en la columna flotante del dashboard — MISMO lenguaje
 * que la card de puja (superficie elevada, cabecera fina, footer con hairline), pero con Aceptar/Rechazar
 * INLINE (la ventana FIXED es corta; un tap). A diferencia de la puja NO lleva riel origen→destino: la
 * oferta FIXED no revela ubicación pre-aceptación (regla #5 del conductor · Ley 29733) — solo tarifa
 * estimada + distancia/duración/ETA-a-recojo. Aceptar → viaje activo; Rechazar/vencer → se va de la lista.
 */
export const FixedOfferCard = ({ offer, onAccepted }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const clearOffer = useDispatchStore((s) => s.clearOffer);
  const setActiveTripId = useDispatchStore((s) => s.setActiveTripId);

  const detail = useOffer(offer.matchId);
  const acceptOffer = useAcceptOffer();
  const rejectOffer = useRejectOffer();

  const secondsLeft = useCountdownMs(toEpochMs(offer.expiresAt));
  const expired = secondsLeft <= 0;

  // Vencida → se cae de la lista (igual que una puja que expira): limpiamos el store, sin pegarle un
  // `reject` inútil al backend (dispatch ya la venció). El dashboard deja de renderizar la card.
  useEffect(() => {
    if (expired) clearOffer();
  }, [expired, clearOffer]);

  const onAccept = () =>
    acceptOffer.mutate(offer.matchId, {
      onSuccess: () => {
        clearOffer();
        setActiveTripId(offer.tripId);
        onAccepted(offer.tripId);
      },
    });

  const onReject = () =>
    rejectOffer.mutate(offer.matchId, {
      onSuccess: () => clearOffer(),
    });

  const surface = {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.lg,
    ...theme.elevation.level1,
  };

  const pickupEta = offer.pickupEtaSeconds;
  const route =
    detail.data != null
      ? `${t('trips.kilometers', { value: metersToKm(detail.data.distanceMeters) })} · ${t('trips.minutes', { value: secondsToMinutes(detail.data.durationSeconds) })}${
          pickupEta && pickupEta > 0
            ? ` · ${t('trips.minutes', { value: secondsToMinutes(pickupEta) })} ${t('trips.pickupEta')}`
            : ''
        }`
      : '';

  return (
    <View style={[styles.card, surface]}>
      {/* CABECERA: punto acento (oferta directa) + "NUEVO VIAJE · Ns" + badge "Reservado" si es programado. */}
      <View style={styles.topLine}>
        <View style={styles.statusGroup}>
          <View style={[styles.dot, { backgroundColor: expired ? theme.colors.danger : theme.colors.accent }]} />
          <Text variant="caption" style={styles.statusLabel} numberOfLines={1} color="inkSubtle">
            {`${t('trips.incomingTitle')} · ${t('trips.incomingExpires', { seconds: secondsLeft })}`}
          </Text>
        </View>
        {offer.scheduled ? (
          <Text variant="caption" color="accent">
            {t('trips.scheduledBadge')}
          </Text>
        ) : null}
      </View>

      {detail.isLoading ? (
        <View style={styles.body}>
          <Skeleton height={52} />
        </View>
      ) : detail.isError || !detail.data ? (
        <View style={styles.body}>
          <Banner
            tone="danger"
            title={t('errors.generic')}
            description={toErrorMessage(detail.error, t)}
            action={{ label: t('common.retry'), onPress: () => detail.refetch() }}
          />
        </View>
      ) : (
        <View style={styles.body}>
          {/* TARIFA estimada como payoff (regla #5: pre-aceptación NO hay origen/destino, solo tarifa + tiempos). */}
          <Text variant="caption" color="inkSubtle">
            {t('trips.estimatedFare')}
          </Text>
          <Text variant="title2" tabular>
            {formatPEN(detail.data.fareCents)}
          </Text>
          <Text variant="caption" color="inkSubtle" numberOfLines={1}>
            {route}
          </Text>
        </View>
      )}

      {/* PIE: hairline + Rechazar (fijo) + Aceptar (flex) inline — 1 tap para la ventana corta. */}
      <View style={[styles.footer, { borderTopColor: theme.colors.border, marginTop: theme.spacing.md, paddingTop: theme.spacing.md }]}>
        <Button
          label={t('trips.reject')}
          variant="secondary"
          loading={rejectOffer.isPending}
          disabled={acceptOffer.isPending || detail.isLoading}
          onPress={onReject}
          style={styles.rejectBtn}
        />
        <Button
          label={t('trips.accept')}
          variant="accent"
          fullWidth
          loading={acceptOffer.isPending}
          disabled={rejectOffer.isPending || detail.isLoading || detail.isError}
          onPress={onAccept}
          style={styles.acceptBtn}
        />
      </View>

      {acceptOffer.isError ? (
        <Banner
          tone="danger"
          title={t('errors.generic')}
          description={toErrorMessage(acceptOffer.error, t)}
          style={styles.errorBanner}
        />
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  card: { minHeight: 44, overflow: 'hidden' },
  topLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusGroup: { flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusLabel: { textTransform: 'uppercase', letterSpacing: 0.6, flexShrink: 1 },
  body: { marginTop: 12, gap: 4 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  rejectBtn: { width: 120 },
  acceptBtn: { flex: 1 },
  errorBanner: { marginTop: 12 },
});
