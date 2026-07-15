import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { TFunction } from 'i18next';
import type { DriverEarningsBreakdown } from '@veo/api-client';
import { Text, useTheme } from '@veo/ui-kit';
import { formatPEN } from '../../../../shared/presentation/format';

export interface PeriodTotalCardProps {
  /** Label del período, ya en mayúsculas (ej. "NETO DE LA SEMANA"). */
  label: string;
  /** Desglose real del período seleccionado (hoy / semana / mes). */
  breakdown: DriverEarningsBreakdown;
  t: TFunction;
}

/**
 * Card "Neto del período" del frame C/Ganancias: label muteado + el NETO como número protagonista y
 * una fila de stats reales (nº de viajes · propinas). Las HORAS del frame se omiten a propósito: no hay
 * dato histórico de horas trabajadas en el contrato — no se inventa un stat que el backend no produce.
 * Debajo, el split HONESTO por método: "En mano (efectivo)" ya lo cobró en el viaje; "A liquidar
 * (digital)" le cae por la liquidación semanal. Solo se dibuja si el contrato trae el split (campos
 * additive: un backend viejo no los envía → la card degrada a su forma previa, sin inventar ceros).
 */
export function PeriodTotalCard({ label, breakdown, t }: PeriodTotalCardProps): React.JSX.Element {
  const theme = useTheme();
  const hasSplit = breakdown.cashNetCents !== undefined && breakdown.digitalNetCents !== undefined;

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.xl,
        },
      ]}
    >
      <Text variant="label" color="inkMuted" style={styles.label}>
        {label}
      </Text>
      <Text variant="display" tabular>
        {formatPEN(breakdown.netCents)}
      </Text>
      <View style={styles.stats}>
        <Text variant="footnote" color="inkMuted" tabular>
          {t('earnings.tripCount', { count: breakdown.tripCount })}
        </Text>
        <Text variant="footnote" color="inkMuted" tabular>
          {t('earnings.tipsStat', { amount: formatPEN(breakdown.tipCents) })}
        </Text>
      </View>

      {hasSplit ? (
        <View style={[styles.split, { borderTopColor: theme.colors.border }]}>
          <View style={styles.splitRow}>
            <Text variant="footnote" color="inkMuted">
              {t('earnings.cashInHand')}
            </Text>
            <Text variant="bodyStrong" tabular>
              {formatPEN(breakdown.cashNetCents ?? 0)}
            </Text>
          </View>
          <View style={styles.splitRow}>
            <Text variant="footnote" color="inkMuted">
              {t('earnings.digitalToSettle')}
            </Text>
            <Text variant="bodyStrong" tabular>
              {formatPEN(breakdown.digitalNetCents ?? 0)}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: 'stretch', borderWidth: StyleSheet.hairlineWidth, padding: 20, gap: 6 },
  label: { textTransform: 'uppercase', letterSpacing: 1 },
  stats: { flexDirection: 'row', gap: 16, marginTop: 6 },
  split: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 10, paddingTop: 12, gap: 6 },
  splitRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
