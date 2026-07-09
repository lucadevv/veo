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
 */
export function PeriodTotalCard({ label, breakdown, t }: PeriodTotalCardProps): React.JSX.Element {
  const theme = useTheme();

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
    </View>
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: 'stretch', borderWidth: StyleSheet.hairlineWidth, padding: 20, gap: 6 },
  label: { textTransform: 'uppercase', letterSpacing: 1 },
  stats: { flexDirection: 'row', gap: 16, marginTop: 6 },
});
