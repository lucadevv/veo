import React from 'react';
import {StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {StatusPill, Text, useTheme, type StatusTone} from '@veo/ui-kit';
import {IconBolt, IconGift} from '../../../../shared/presentation/icons';
import {formatPEN, formatShortDate} from '../../../../shared/presentation/format';
import {
  formatMultiplier,
  incentiveProgressFraction,
  incentiveProgressPercent,
  incentiveState,
  incentiveTripsRemaining,
  isMultiplierIncentive,
  type Incentive,
} from '../../domain';
import {AnimatedBar} from './motion';

export interface IncentiveCardProps {
  incentive: Incentive;
}

/**
 * Tarjeta de un incentivo (lenguaje Midnight Motion). Motivadora pero legible en poca luz:
 *  - META_VIAJES: barra de progreso (progressTrips/targetTrips) + recompensa en soles + viajes que
 *    faltan.
 *  - HORA_PICO: multiplicador destacado (bps → "+X%").
 * Estado (activo/completado/vencido) como chip. Sin animaciones llamativas: el progreso comunica.
 */
export function IncentiveCard({incentive}: IncentiveCardProps): React.JSX.Element {
  const {t} = useTranslation();
  const theme = useTheme();

  const state = incentiveState(incentive);
  const isMultiplier = isMultiplierIncentive(incentive.type);
  const fraction = incentiveProgressFraction(incentive);
  const percent = incentiveProgressPercent(incentive);
  const remaining = incentiveTripsRemaining(incentive);

  const stateTone: StatusTone =
    state === 'completed' ? 'success' : state === 'expired' ? 'neutral' : 'accent';
  const stateLabel =
    state === 'completed'
      ? t('ops.incentives.stateCompleted')
      : state === 'expired'
        ? t('ops.incentives.stateExpired')
        : t('ops.incentives.stateActive');

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surfaceElevated,
          borderColor: state === 'completed' ? theme.colors.accent : theme.colors.border,
          borderRadius: theme.radii.xl,
          padding: theme.spacing['2xl'],
          gap: theme.spacing.lg,
          opacity: state === 'expired' ? 0.7 : 1,
        },
      ]}>
      <View style={styles.head}>
        <View style={[styles.iconWrap, {backgroundColor: theme.colors.bg, borderRadius: theme.radii.md}]}>
          {isMultiplier ? (
            <IconBolt size={22} color={theme.colors.accent} />
          ) : (
            <IconGift size={22} color={theme.colors.accent} />
          )}
        </View>
        <View style={styles.flex}>
          <Text variant="headline" numberOfLines={1}>
            {incentive.title}
          </Text>
          <Text variant="footnote" color="inkMuted" numberOfLines={2}>
            {incentive.description}
          </Text>
        </View>
        <StatusPill label={stateLabel} tone={stateTone} dot />
      </View>

      {isMultiplier ? (
        // HORA_PICO: el multiplicador es la métrica protagonista.
        <View style={styles.rewardBlock}>
          <View style={[styles.accentRule, {backgroundColor: theme.colors.accent}]} />
          <Text variant="footnote" color="inkSubtle">
            {t('ops.incentives.multiplierLabel')}
          </Text>
          <Text variant="display" color="accent" tabular>
            {formatMultiplier(incentive.multiplierBps)}
          </Text>
        </View>
      ) : (
        // META_VIAJES: barra de progreso + recompensa + viajes restantes.
        <View style={styles.metaBlock}>
          <View style={styles.progressHead}>
            <Text variant="subhead" tabular>
              {t('ops.incentives.tripsProgress', {
                done: incentive.progressTrips,
                total: incentive.targetTrips,
              })}
            </Text>
            <Text variant="subhead" color="accent" tabular>
              {formatPEN(incentive.rewardCents)}
            </Text>
          </View>

          <AnimatedBar
            fraction={fraction}
            percent={percent}
            color={state === 'completed' ? theme.colors.success : theme.colors.accent}
            trackColor={theme.colors.bg}
            radius={theme.radii.pill}
          />

          <Text variant="footnote" color="inkMuted">
            {state === 'completed'
              ? t('ops.incentives.goalReached')
              : t('ops.incentives.tripsRemaining', {count: remaining})}
          </Text>
        </View>
      )}

      <View style={[styles.divider, {backgroundColor: theme.colors.border}]} />
      <Text variant="caption" color="inkSubtle">
        {t('ops.incentives.expiresOn', {date: formatShortDate(incentive.expiresAt)})}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {alignSelf: 'stretch', borderWidth: StyleSheet.hairlineWidth},
  flex: {flex: 1, gap: 2},
  head: {flexDirection: 'row', alignItems: 'center', gap: 12},
  iconWrap: {width: 40, height: 40, alignItems: 'center', justifyContent: 'center'},
  rewardBlock: {gap: 4},
  accentRule: {width: 36, height: 3, borderRadius: 999, marginBottom: 6},
  metaBlock: {gap: 10},
  progressHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  divider: {height: StyleSheet.hairlineWidth, alignSelf: 'stretch'},
});
