import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Card, StatusPill, Text, useTheme } from '@veo/ui-kit';
import { formatPEN } from '../../../../shared/presentation/format';
import { vehicleClassLabelKey } from '../../../../shared/presentation/vehicle-class';
import type { OpenBid } from '../../domain';
import { useCountdownMs } from '../hooks/useCountdownMs';
import { useDispatchStore } from '../../../realtime/presentation/state/dispatchStore';

interface Props {
  bid: OpenBid;
  onPress: () => void;
}

/**
 * Una puja OPEN en la lista: tarifa propuesta como foco, vehículo + solicitudes especiales, y un pill de
 * cuenta atrás (vive mientras la ventana sigue abierta). Tap → abre el sheet para aceptar/contraofertar.
 */
export const BidCard = ({ bid, onPress }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const secondsLeft = useCountdownMs(bid.expiresAt);
  const expired = secondsLeft <= 0;
  // ADR-020 Lote 2 (2b) — el conductor YA ofertó en esta puja y espera al pasajero: la card lo refleja
  // (pill "Enviada" + CTA honesto) en vez de invitar a "Ofertar" otra vez. El estado vive en el store.
  const pending = useDispatchStore((s) => s.pendingBidTripIds.includes(bid.tripId));

  return (
    <Card
      variant="outlined"
      padding="lg"
      onPress={onPress}
      accessibilityLabel={t('trips.bid.open')}
    >
      <View style={styles.headRow}>
        <View style={styles.amountBlock}>
          <Text variant="footnote" color="inkMuted">
            {t('trips.bid.title')}
          </Text>
          <Text variant="title1" tabular>
            {formatPEN(bid.bidCents)}
          </Text>
        </View>
        {pending ? (
          <StatusPill label={t('trips.bid.pendingPill')} tone="accent" live dot />
        ) : (
          <StatusPill
            label={
              expired ? t('trips.bid.expired') : t('trips.bid.expiresIn', { seconds: secondsLeft })
            }
            tone={expired ? 'danger' : 'warn'}
            live={!expired}
            dot
          />
        )}
      </View>

      <View style={styles.metaRow}>
        <StatusPill label={t(vehicleClassLabelKey(bid.vehicleType))} tone="accent" dot />
        {bid.specialRequests.map((req) => (
          <StatusPill
            key={req}
            label={t(`trips.bid.special.${req}`, { defaultValue: req })}
            tone="neutral"
          />
        ))}
      </View>

      <Text
        variant="footnote"
        color={pending ? 'inkMuted' : 'accent'}
        style={[styles.cta, pending ? null : { color: theme.colors.accent }]}
      >
        {pending ? t('trips.bid.waiting') : `${t('trips.bid.open')} →`}
      </Text>
    </Card>
  );
};

const styles = StyleSheet.create({
  headRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  amountBlock: { gap: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  cta: { marginTop: 12 },
});
