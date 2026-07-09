import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { TFunction } from 'i18next';
import type { DriverDailyEarnings } from '@veo/api-client';
import { Text, useTheme } from '@veo/ui-kit';

export interface WeeklyBarChartProps {
  /** Serie de la semana en curso (7 puntos lun→dom). Días sin viajes vienen en 0. */
  days: DriverDailyEarnings[];
  t: TFunction;
}

const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const BAR_MAX_PX = 88;

/**
 * Bar chart "Por día" (frame C/Ganancias): 7 barras lun→dom con el neto diario. La barra del día de
 * MAYOR neto se resalta en acento; el resto en superficie elevada (sutiles). Alturas proporcionales al
 * máximo real de la semana; días en cero muestran una barra mínima (nunca vacía). Sin librería de charts.
 */
export function WeeklyBarChart({ days, t }: WeeklyBarChartProps): React.JSX.Element {
  const theme = useTheme();

  const { maxNet, peakIndex } = useMemo(() => {
    let max = 0;
    let peak = -1;
    days.forEach((d, i) => {
      if (d.netCents > max) {
        max = d.netCents;
        peak = i;
      }
    });
    return { maxNet: max, peakIndex: peak };
  }, [days]);

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
        },
      ]}
    >
      <Text variant="footnote" color="inkMuted" style={styles.title}>
        {t('earnings.byDay')}
      </Text>

      <View style={styles.bars} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {days.slice(0, 7).map((day, index) => {
          const ratio = maxNet > 0 ? day.netCents / maxNet : 0;
          const height = Math.max(4, Math.round(ratio * BAR_MAX_PX));
          const isPeak = index === peakIndex && maxNet > 0;
          return (
            <View key={day.date} style={styles.col}>
              <View
                style={[
                  styles.bar,
                  {
                    height,
                    backgroundColor: isPeak ? theme.colors.accent : theme.colors.surfaceElevated,
                  },
                ]}
              />
              <Text variant="caption" color={isPeak ? 'accent' : 'inkSubtle'}>
                {t(`earnings.weekdayInitials.${WEEKDAY_KEYS[index]}`)}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: 'stretch', borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 10 },
  title: { fontWeight: '600' },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  col: { flex: 1, alignItems: 'center', gap: 6 },
  bar: { alignSelf: 'stretch', borderRadius: 6 },
});
