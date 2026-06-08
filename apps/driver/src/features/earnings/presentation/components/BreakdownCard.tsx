import React from 'react';
import {StyleSheet, View} from 'react-native';
import type {TFunction} from 'i18next';
import type {DriverEarningsBreakdown} from '@veo/api-client';
import {Text, useTheme} from '@veo/ui-kit';
import {IconTrips} from '../../../../shared/presentation/icons';
import {formatPEN} from '../../../../shared/presentation/format';

export interface BreakdownCardProps {
  /** Título del período (ej. "Hoy" / "Esta semana"). */
  periodLabel: string;
  /** Desglose real del período (céntimos PEN). Sin transformaciones inventadas. */
  breakdown: DriverEarningsBreakdown;
  t: TFunction;
}

/**
 * Tarjeta de desglose de un período (lenguaje Midnight Motion). Diseño denso pero legible: el NETO
 * es la métrica protagonista (acento cian, display), seguido de las líneas que lo componen —bruto,
 * comisión (en rojo, resta) y propinas (verde, suma)— y un pie con el número de viajes.
 *
 * Solo usa los campos reales del contrato `DriverEarningsBreakdown`:
 * `grossCents`, `commissionCents`, `tipCents`, `netCents`, `tripCount`.
 */
export function BreakdownCard({periodLabel, breakdown, t}: BreakdownCardProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surfaceElevated,
          borderRadius: theme.radii.xl,
          padding: theme.spacing['2xl'],
          gap: theme.spacing.lg,
        },
      ]}>
      {/* Encabezado: período + nº de viajes compacto. */}
      <View style={styles.head}>
        <Text variant="subhead" color="inkMuted" style={styles.flex}>
          {periodLabel}
        </Text>
        <View
          style={[
            styles.tripChip,
            {
              backgroundColor: theme.colors.bg,
              borderRadius: theme.radii.pill,
              gap: theme.spacing.xs,
            },
          ]}>
          <IconTrips size={14} color={theme.colors.inkSubtle} strokeWidth={2} />
          <Text variant="label" color="inkSubtle" tabular>
            {t('earnings.tripCount', {count: breakdown.tripCount})}
          </Text>
        </View>
      </View>

      {/* Métrica protagonista: NETO con tinte cian y numerales tabulares. */}
      <View style={styles.netBlock}>
        <View style={[styles.accentRule, {backgroundColor: theme.colors.accent}]} />
        <Text variant="footnote" color="inkSubtle">
          {t('earnings.net')}
        </Text>
        <Text variant="display" color="accent" tabular>
          {formatPEN(breakdown.netCents)}
        </Text>
      </View>

      <View style={[styles.divider, {backgroundColor: theme.colors.border}]} />

      {/* Líneas que componen el neto (denso, una por fila). */}
      <View style={styles.lines}>
        <BreakdownLine
          label={t('earnings.gross')}
          value={formatPEN(breakdown.grossCents)}
          valueColor="ink"
        />
        <BreakdownLine
          label={t('earnings.commission')}
          // La comisión resta: la mostramos con signo y en tono de advertencia/riesgo.
          value={`- ${formatPEN(breakdown.commissionCents)}`}
          valueColor="danger"
        />
        <BreakdownLine
          label={t('earnings.tips')}
          value={`+ ${formatPEN(breakdown.tipCents)}`}
          valueColor="success"
        />
      </View>
    </View>
  );
}

interface BreakdownLineProps {
  label: string;
  value: string;
  valueColor: 'ink' | 'danger' | 'success';
}

/** Fila etiqueta–monto del desglose. Privada de la tarjeta. */
function BreakdownLine({label, value, valueColor}: BreakdownLineProps): React.JSX.Element {
  return (
    <View style={styles.line}>
      <Text variant="callout" color="inkMuted" style={styles.flex} numberOfLines={1}>
        {label}
      </Text>
      <Text variant="bodyStrong" color={valueColor} tabular numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {flex: 1},
  card: {alignSelf: 'stretch'},
  head: {flexDirection: 'row', alignItems: 'center'},
  tripChip: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 4},
  netBlock: {gap: 4},
  accentRule: {width: 36, height: 3, borderRadius: 999, marginBottom: 6},
  divider: {height: StyleSheet.hairlineWidth, alignSelf: 'stretch'},
  lines: {gap: 10},
  line: {flexDirection: 'row', alignItems: 'center'},
});
