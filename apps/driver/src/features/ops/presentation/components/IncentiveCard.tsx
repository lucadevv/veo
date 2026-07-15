import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { hexAlpha, Text, useTheme } from '@veo/ui-kit';
import { IconBolt, IconTarget } from '../../../../shared/presentation/icons';
import { formatPEN } from '../../../../shared/presentation/format';
import {
  formatMultiplier,
  incentiveProgressFraction,
  incentiveProgressPercent,
  incentiveState,
  isMultiplierIncentive,
  type Incentive,
} from '../../domain';
import { AnimatedBar } from './motion';

export interface IncentiveCardProps {
  incentive: Incentive;
}

/**
 * Tarjeta compacta de un incentivo (frame `C/Incentivos`): tile de icono tintado por tipo + título/
 * subtítulo + el valor (bono en soles o multiplicador) a la derecha. Los META_VIAJES suman una barra
 * de progreso + el conteo "N de M". Color por TIPO (META=accent, HORA_PICO=warn); completado→success,
 * vencido→atenuado. Sin chip de estado ni fecha (el frame no los muestra; la vigencia va en el hero).
 */
export function IncentiveCard({ incentive }: IncentiveCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const theme = useTheme();

  const isMultiplier = isMultiplierIncentive(incentive.type);
  const state = incentiveState(incentive);
  const fraction = incentiveProgressFraction(incentive);
  const percent = incentiveProgressPercent(incentive);

  const tone = isMultiplier
    ? theme.colors.warn
    : state === 'completed'
      ? theme.colors.success
      : theme.colors.accent;
  const Glyph = isMultiplier ? IconBolt : IconTarget;
  const value = isMultiplier
    ? `+${formatMultiplier(incentive.multiplierBps)}`
    : `+${formatPEN(incentive.rewardCents)}`;

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surfaceElevated,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          padding: theme.spacing.lg,
          gap: theme.spacing.md,
          opacity: state === 'expired' ? 0.6 : 1,
        },
      ]}
    >
      <View style={styles.head}>
        <View
          style={[
            styles.iconTile,
            { backgroundColor: hexAlpha(tone, 0.15), borderRadius: theme.radii.md },
          ]}
        >
          <Glyph size={20} color={tone} />
        </View>
        <View style={styles.flex}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {incentive.title}
          </Text>
          <Text variant="footnote" color="inkMuted" numberOfLines={1}>
            {incentive.description}
          </Text>
        </View>
        <Text variant="bodyStrong" style={{ color: tone }} tabular>
          {value}
        </Text>
      </View>

      {isMultiplier ? null : (
        <>
          <AnimatedBar
            fraction={fraction}
            percent={percent}
            color={tone}
            trackColor={theme.colors.surfaceMuted}
            radius={theme.radii.pill}
          />
          <Text variant="caption" color="inkSubtle" tabular>
            {t('ops.incentives.progressCount', {
              done: incentive.progressTrips,
              total: incentive.targetTrips,
            })}
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: 'stretch', borderWidth: StyleSheet.hairlineWidth },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flex: { flex: 1, gap: 2 },
  iconTile: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
