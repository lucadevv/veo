import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { TFunction } from 'i18next';
import { Text, useTheme } from '@veo/ui-kit';
import { IconClock } from '../../../../shared/presentation/icons';
import { formatPEN } from '../../../../shared/presentation/format';

export interface PayoutInfoCardProps {
  /** Neto pendiente de liquidar (céntimos PEN). */
  pendingNetCents: number;
  t: TFunction;
}

/**
 * Card "Por liquidar" del frame C/Ganancias, en su forma HONESTA al modelo de negocio: el frame dibuja
 * un botón "Liquidar", pero la liquidación es admin-only y automática (proceso LNS semanal, rol FINANCE)
 * — el conductor no puede auto-liquidar. Por eso el botón se reemplaza por un chip "Automático" + la nota
 * "Se liquida automáticamente cada semana": informa sin ofrecer una acción que no existe.
 */
export function PayoutInfoCard({ pendingNetCents, t }: PayoutInfoCardProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.accent + '26',
          borderColor: theme.colors.accent,
          borderRadius: theme.radii.lg,
        },
      ]}
    >
      <View style={styles.row}>
        <View style={styles.amountCol}>
          <Text variant="footnote" color="inkMuted">
            {t('earnings.pendingPayoutLabel')}
          </Text>
          <Text variant="title3" tabular>
            {formatPEN(pendingNetCents)}
          </Text>
        </View>
        <View style={[styles.chip, { backgroundColor: theme.colors.accent + '26' }]}>
          <IconClock size={14} color={theme.colors.accent} strokeWidth={2} />
          <Text variant="caption" color="accent">
            {t('earnings.autoSettleChip')}
          </Text>
        </View>
      </View>
      <Text variant="caption" color="inkMuted">
        {t('earnings.autoSettleInfo')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: 'stretch', borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  amountCol: { gap: 2 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
});
