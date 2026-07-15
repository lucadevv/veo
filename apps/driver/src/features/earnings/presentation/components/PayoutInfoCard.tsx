import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { TFunction } from 'i18next';
import { Button, Text, useTheme } from '@veo/ui-kit';
import { IconClock } from '../../../../shared/presentation/icons';
import { formatPEN } from '../../../../shared/presentation/format';

export interface PayoutInfoCardProps {
  /** Neto pendiente de liquidar (céntimos PEN): devengado abierto + payouts no pagados − deuda. */
  pendingNetCents: number;
  /** Deuda CASH pendiente con VEO (céntimos PEN). La fila solo se muestra si es > 0. */
  pendingDebtCents?: number;
  /**
   * ADR-022 §P-A · acción "Saldar ahora" de la fila de deuda: la deuda es ACCIONABLE (lleva a Saldar deuda),
   * no solo informativa. Solo se ofrece con deuda pendiente (> 0). Si se omite, la fila queda informativa.
   */
  onSettle?: () => void;
  t: TFunction;
}

/**
 * Card "Por liquidar" del frame C/Ganancias, en su forma HONESTA al modelo de negocio: el frame dibuja
 * un botón "Liquidar", pero la liquidación es admin-only y automática (proceso LNS semanal, rol FINANCE)
 * — el conductor no puede auto-liquidar. Por eso el botón se reemplaza por un chip "Automático" + la nota
 * "Se liquida automáticamente cada semana": informa sin ofrecer una acción que no existe.
 * Si el conductor debe comisión de viajes en efectivo (deuda CASH pendiente), se muestra la fila
 * "Debés a VEO" con su explicación — antes esa deuda era invisible y el descuento en la liquidación
 * aparecía sin explicación.
 */
export function PayoutInfoCard({
  pendingNetCents,
  pendingDebtCents = 0,
  onSettle,
  t,
}: PayoutInfoCardProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radii.lg,
          ...theme.elevation.level1,
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
        <View style={[styles.chip, { backgroundColor: theme.colors.brandDim }]}>
          <IconClock size={14} color={theme.colors.accent} strokeWidth={2} />
          <Text variant="caption" color="accent">
            {t('earnings.autoSettleChip')}
          </Text>
        </View>
      </View>
      <Text variant="caption" color="inkMuted">
        {t('earnings.autoSettleInfo')}
      </Text>

      {pendingDebtCents > 0 ? (
        <View style={[styles.debtBlock, { borderTopColor: theme.colors.border }]}>
          <View style={styles.row}>
            <Text variant="footnote" color="inkMuted">
              {t('earnings.pendingDebtLabel')}
            </Text>
            <Text variant="bodyStrong" color="warn" tabular>
              −{formatPEN(pendingDebtCents)}
            </Text>
          </View>
          <Text variant="caption" color="inkMuted">
            {t('earnings.pendingDebtInfo')}
          </Text>
          {onSettle ? (
            <Button
              label={t('earnings.settleDebtCta')}
              variant="primary"
              fullWidth
              onPress={onSettle}
              style={styles.settleBtn}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: 'stretch', padding: 16, gap: 10 },
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
  debtBlock: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, gap: 4 },
  settleBtn: { marginTop: 8 },
});
