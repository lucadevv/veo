import { Button, Card, Text, useTheme } from '@veo/ui-kit';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Share, StyleSheet, View } from 'react-native';
import {
  formatDistance,
  formatDurationMinutes,
  formatPEN,
} from '../../../../shared/utils/format';
import { formatReceiptText, type TripReceipt } from '../../domain/receipt';

export interface TripReceiptCardProps {
  receipt: TripReceipt;
}

/** Fila etiqueta/valor del desglose. El valor usa números tabulares cuando es dinero/medida. */
function Row({
  label,
  value,
  strong,
  tabular,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tabular?: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text variant={strong ? 'bodyStrong' : 'callout'} color={strong ? 'ink' : 'inkMuted'}>
        {label}
      </Text>
      <Text variant={strong ? 'bodyStrong' : 'body'} tabular={tabular}>
        {value}
      </Text>
    </View>
  );
}

/**
 * Recibo del viaje COMPLETADO: desglose (tarifa base, surge, propina, total, método, fecha,
 * conductor, recorrido) y botón "Compartir recibo" con el Share nativo de RN. Solo muestra las
 * filas con dato real (omite con gracia las ausentes).
 */
export function TripReceiptCard({ receipt }: TripReceiptCardProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();

  const onShare = useCallback(() => {
    const text = formatReceiptText(receipt, {
      title: t('receipt.shareTitle'),
      baseFare: t('receipt.baseFare'),
      surge: (multiplier) => t('receipt.surge', { multiplier }),
      tip: t('receipt.tip'),
      total: t('receipt.total'),
      paymentMethod: t('receipt.paymentMethod'),
      date: t('receipt.date'),
      driver: t('receipt.driver'),
      vehicle: t('receipt.vehicle'),
      route: t('receipt.route'),
      distance: t('receipt.distance'),
      duration: t('receipt.duration'),
      durationMinutes: (minutes) => t('receipt.durationMinutes', { minutes }),
    });
    void Share.share({ title: t('receipt.shareTitle'), message: text });
  }, [receipt, t]);

  return (
    <Card variant="outlined" padding="lg">
      <Text variant="title3">{t('receipt.title')}</Text>

      <View style={{ gap: theme.spacing.sm, marginTop: theme.spacing.lg }}>
        <Row label={t('receipt.baseFare')} value={formatPEN(receipt.baseFareCents)} tabular />
        {receipt.surgeMultiplier ? (
          <Row
            label={t('receipt.surge', { multiplier: receipt.surgeMultiplier })}
            value={`×${receipt.surgeMultiplier}`}
            tabular
          />
        ) : null}
        {receipt.tipCents > 0 ? (
          <Row label={t('receipt.tip')} value={formatPEN(receipt.tipCents)} tabular />
        ) : null}

        <View style={[styles.divider, { backgroundColor: theme.colors.border, marginVertical: theme.spacing.xs }]} />

        <Row label={t('receipt.total')} value={formatPEN(receipt.totalCents)} strong tabular />
        <Row label={t('receipt.paymentMethod')} value={receipt.paymentMethod} />
      </View>

      <View
        style={[
          styles.meta,
          { gap: theme.spacing.sm, marginTop: theme.spacing.lg, paddingTop: theme.spacing.lg, borderTopColor: theme.colors.border },
        ]}
      >
        {receipt.date ? <Row label={t('receipt.date')} value={receipt.date} /> : null}
        {receipt.driverLabel ? <Row label={t('receipt.driver')} value={receipt.driverLabel} tabular /> : null}
        {receipt.vehicleLabel ? <Row label={t('receipt.vehicle')} value={receipt.vehicleLabel} /> : null}
        <Row label={t('receipt.distance')} value={formatDistance(receipt.distanceMeters)} tabular />
        <Row
          label={t('receipt.duration')}
          value={t('receipt.durationMinutes', {
            minutes: formatDurationMinutes(receipt.durationSeconds),
          })}
          tabular
        />
        {receipt.originLabel && receipt.destinationLabel ? (
          <View style={{ marginTop: theme.spacing.xs }}>
            <Text variant="footnote" color="inkMuted">
              {t('receipt.route')}
            </Text>
            <Text variant="footnote" tabular>
              {receipt.originLabel} → {receipt.destinationLabel}
            </Text>
          </View>
        ) : null}
      </View>

      <Button
        label={t('receipt.share')}
        variant="secondary"
        fullWidth
        onPress={onShare}
        style={{ marginTop: theme.spacing.lg }}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  divider: { height: StyleSheet.hairlineWidth },
  meta: { borderTopWidth: StyleSheet.hairlineWidth },
});
