import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PressableScale, Text, useTheme } from '@veo/ui-kit';
import {
  formatPEN,
  metersToKm,
  secondsToMinutes,
} from '../../../../shared/presentation/format';
import { vehicleClassGlyph, vehicleClassLabelKey } from '../../../../shared/presentation/vehicle-class';
import type { OpenBid } from '../../domain';
import { useCountdownMs } from '../../../../shared/presentation/hooks/useCountdownMs';
import { useDispatchStore } from '../../../realtime/presentation/state/dispatchStore';
import { useReverseLabel } from '../hooks/useReverseLabel';

interface Props {
  bid: OpenBid;
  onPress: () => void;
}

/**
 * Una puja OPEN en la lista (dock + board), en el lenguaje EDITORIAL de la fila del historial: superficie con
 * elevación (sin borde), cabecera fina (PUJA + countdown · ícono del tier), TRAYECTO como RIEL origen→destino
 * con etiquetas a nivel DISTRITO (reverse-geocode de los puntos OFUSCADOS a ~111m — Ley 29733, no se revela la
 * puerta exacta pre-aceptación), distancia·duración, y footer con el MONTO ofrecido como payoff. Tap → sheet
 * para TOMAR la tarifa o CONTRAOFERTAR.
 */
export const BidCard = ({ bid, onPress }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const secondsLeft = useCountdownMs(bid.expiresAt);
  const expired = secondsLeft <= 0;
  // ADR-020: el conductor YA ofertó en esta puja y espera al pasajero → la card lo refleja (sin invitar a ofertar otra vez).
  const pending = useDispatchStore((s) => s.pendingBidTripIds.includes(bid.tripId));

  const originLabel = useReverseLabel(bid.originLat, bid.originLon);
  const destLabel = useReverseLabel(bid.destLat, bid.destLon);
  const VehicleIcon = vehicleClassGlyph(bid.vehicleType);
  const route = `${t('trips.kilometers', { value: metersToKm(bid.distanceMeters) })} · ${t('trips.minutes', { value: secondsToMinutes(bid.durationSeconds) })}`;

  // El punto lleva el color (brand=PUJA activa / danger=vencida); la etiqueta va neutra (mismo criterio que el historial).
  const dotColor = expired ? theme.colors.danger : theme.colors.brand;
  const countdownColor = expired ? 'danger' : 'warn';

  return (
    <PressableScale
      accessible
      accessibilityRole="button"
      accessibilityLabel={t('trips.bid.open')}
      onPress={onPress}
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radii.lg,
          padding: theme.spacing.lg,
          ...theme.elevation.level1,
        },
      ]}
    >
      {/* CABECERA FINA: PUJA + countdown (o "Enviada") a la izquierda · ícono del tier a la derecha. */}
      <View style={styles.topLine}>
        <View style={styles.statusGroup}>
          <View style={[styles.dot, { backgroundColor: pending ? theme.colors.accent : dotColor }]} />
          <Text variant="caption" style={styles.statusLabel} numberOfLines={1} color="inkSubtle">
            {pending
              ? t('trips.bid.pendingPill')
              : expired
                ? t('trips.bid.expired')
                : `${t('trips.bid.tag')} · ${t('trips.bid.expiresIn', { seconds: secondsLeft })}`}
          </Text>
        </View>
        <VehicleIcon color={theme.colors.inkSubtle} size={16} />
      </View>

      {/* CUERPO: TRAYECTO como riel origen(distrito) → distancia·duración → destino(distrito). */}
      <View style={styles.body}>
        <View
          style={styles.rail}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <View style={[styles.railDotOrigin, { borderColor: theme.colors.brand }]} />
          <View style={[styles.railLine, { backgroundColor: theme.colors.border }]} />
          <View style={[styles.railDotDest, { backgroundColor: theme.colors.ink }]} />
        </View>
        <View style={styles.labels}>
          <Text variant="subhead" color="inkMuted" numberOfLines={1}>
            {originLabel ?? t('trips.bid.locating')}
          </Text>
          <Text variant="caption" color="inkSubtle" numberOfLines={1}>
            {route}
          </Text>
          <Text variant="bodyStrong" numberOfLines={1}>
            {destLabel ?? t('trips.bid.locating')}
          </Text>
        </View>
      </View>

      {/* PIE: hairline + monto ofrecido (payoff) + CTA (tomar/ofertar) o "esperando". */}
      <View style={[styles.footer, { borderTopColor: theme.colors.border, marginTop: theme.spacing.md, paddingTop: theme.spacing.md }]}>
        <Text variant="title2" tabular>
          {formatPEN(bid.bidCents)}
        </Text>
        <Text variant="bodyStrong" color={pending ? 'inkMuted' : 'accent'}>
          {pending ? t('trips.bid.waiting') : `${t('trips.bid.open')} →`}
        </Text>
      </View>
    </PressableScale>
  );
};

const RAIL_DOT = 10;

const styles = StyleSheet.create({
  card: { minHeight: 44, overflow: 'hidden' },
  topLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusGroup: { flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusLabel: { textTransform: 'uppercase', letterSpacing: 0.6, flexShrink: 1 },
  body: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, marginTop: 14 },
  rail: { width: RAIL_DOT, alignItems: 'center', paddingTop: 5 },
  railDotOrigin: { width: RAIL_DOT, height: RAIL_DOT, borderRadius: RAIL_DOT / 2, borderWidth: 2.5 },
  railLine: { width: 2, flex: 1, marginVertical: 4, minHeight: 22 },
  railDotDest: { width: RAIL_DOT, height: RAIL_DOT, borderRadius: 2 },
  labels: { flex: 1, gap: 6 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
});
