import React from 'react';
import {StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {Card, StatusPill, Text, useTheme} from '@veo/ui-kit';
import {formatPEN} from '../../../../shared/presentation/format';
import type {OpenBid} from '../../domain';
import {useCountdownMs} from '../hooks/useCountdownMs';

interface Props {
  bid: OpenBid;
  onPress: () => void;
}

/** Etiqueta i18n del tipo de vehículo (reusa las claves de shift). */
function vehicleLabel(type: string): 'shift.vehicleType.car' | 'shift.vehicleType.moto' {
  return type === 'MOTO' ? 'shift.vehicleType.moto' : 'shift.vehicleType.car';
}

/**
 * Una puja OPEN en la lista: tarifa propuesta como foco, vehículo + solicitudes especiales, y un pill de
 * cuenta atrás (vive mientras la ventana sigue abierta). Tap → abre el sheet para aceptar/contraofertar.
 */
export const BidCard = ({bid, onPress}: Props): React.JSX.Element => {
  const {t} = useTranslation();
  const theme = useTheme();
  const secondsLeft = useCountdownMs(bid.expiresAt);
  const expired = secondsLeft <= 0;

  return (
    <Card variant="outlined" padding="lg" onPress={onPress} accessibilityLabel={t('trips.bid.open')}>
      <View style={styles.headRow}>
        <View style={styles.amountBlock}>
          <Text variant="footnote" color="inkMuted">
            {t('trips.bid.title')}
          </Text>
          <Text variant="title1" tabular>
            {formatPEN(bid.bidCents)}
          </Text>
        </View>
        <StatusPill
          label={expired ? t('trips.bid.expired') : t('trips.bid.expiresIn', {seconds: secondsLeft})}
          tone={expired ? 'danger' : 'warn'}
          live={!expired}
          dot
        />
      </View>

      <View style={styles.metaRow}>
        <StatusPill label={t(vehicleLabel(bid.vehicleType))} tone="accent" dot />
        {bid.specialRequests.map(req => (
          <StatusPill key={req} label={t(`trips.bid.special.${req}`, {defaultValue: req})} tone="neutral" />
        ))}
      </View>

      <Text variant="footnote" color="accent" style={[styles.cta, {color: theme.colors.accent}]}>
        {t('trips.bid.open')} →
      </Text>
    </Card>
  );
};

const styles = StyleSheet.create({
  headRow: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12},
  amountBlock: {gap: 2},
  metaRow: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 12},
  cta: {marginTop: 12},
});
