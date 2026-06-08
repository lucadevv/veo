import React from 'react';
import {StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {Text, useTheme} from '@veo/ui-kit';

/**
 * Leyenda simple del mapa de calor de demanda: tres niveles (baja/media/alta) representados por
 * puntos cian de opacidad creciente. Compacta, pensada para flotar sobre el mapa sin tapar la
 * lectura. Si no hay celdas, el llamador muestra un texto de "sin demanda" en su lugar.
 */
export function DemandLegend(): React.JSX.Element {
  const {t} = useTranslation();
  const theme = useTheme();
  const levels: Array<{key: string; opacity: number; label: string}> = [
    {key: 'low', opacity: 0.2, label: t('ops.demand.legendLow')},
    {key: 'medium', opacity: 0.4, label: t('ops.demand.legendMedium')},
    {key: 'high', opacity: 0.6, label: t('ops.demand.legendHigh')},
  ];

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.md,
          ...theme.elevation.level2,
        },
      ]}>
      <Text variant="footnote" color="inkMuted" style={styles.title}>
        {t('ops.demand.legendTitle')}
      </Text>
      <View style={styles.row}>
        {levels.map(level => (
          <View key={level.key} style={styles.item}>
            <View
              style={[
                styles.dot,
                {backgroundColor: theme.colors.accent, opacity: level.opacity},
              ]}
            />
            <Text variant="caption" color="inkSubtle">
              {level.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {paddingHorizontal: 12, paddingVertical: 8, borderWidth: StyleSheet.hairlineWidth, gap: 6},
  title: {fontWeight: '600'},
  row: {flexDirection: 'row', gap: 14},
  item: {flexDirection: 'row', alignItems: 'center', gap: 6},
  dot: {width: 12, height: 12, borderRadius: 6},
});
