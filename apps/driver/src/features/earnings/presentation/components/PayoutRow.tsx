import React from 'react';
import {StyleSheet, View} from 'react-native';
import {StatusPill, Text, useTheme, type StatusTone} from '@veo/ui-kit';
import {IconReceipt} from '../../../../shared/presentation/icons';

export interface PayoutRowProps {
  /** Monto de la liquidación ya formateado (formatPEN). */
  amountLabel: string;
  /** Periodo de la liquidación ya formateado (inicio – fin). */
  periodLabel: string;
  /** Etiqueta de estado (traducida) y su tono semántico — el mapeo vive en la pantalla. */
  statusLabel: string;
  statusTone: StatusTone;
  /** Oculta el divisor superior en la primera fila. */
  showDivider?: boolean;
}

/**
 * Fila de liquidación (payout) con lenguaje Midnight Motion: ícono en superficie, monto tabular,
 * periodo muted y `StatusPill` a la derecha. No contiene lógica: recibe ya formateado lo que la
 * pantalla calcula a partir de los datos reales del summary.
 */
export function PayoutRow({
  amountLabel,
  periodLabel,
  statusLabel,
  statusTone,
  showDivider = true,
}: PayoutRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View>
      {showDivider ? (
        <View style={[styles.divider, {backgroundColor: theme.colors.border}]} />
      ) : null}
      <View style={[styles.row, {paddingVertical: theme.spacing.md, gap: theme.spacing.lg}]}>
        <View
          style={[
            styles.icon,
            {
              backgroundColor: theme.colors.bg,
              borderRadius: theme.radii.md,
              borderColor: theme.colors.border,
            },
          ]}>
          <IconReceipt size={20} color={theme.colors.accent} strokeWidth={2} />
        </View>
        <View style={styles.body}>
          <Text variant="bodyStrong" tabular numberOfLines={1}>
            {amountLabel}
          </Text>
          <Text variant="footnote" color="inkMuted" numberOfLines={1}>
            {periodLabel}
          </Text>
        </View>
        <StatusPill label={statusLabel} tone={statusTone} dot />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  divider: {height: StyleSheet.hairlineWidth, alignSelf: 'stretch'},
  row: {flexDirection: 'row', alignItems: 'center'},
  icon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  body: {flex: 1, gap: 2},
});
