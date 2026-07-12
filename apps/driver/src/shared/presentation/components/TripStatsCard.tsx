import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { Text, useTheme } from '@veo/ui-kit';
import type { IconProps } from '../icons';

/** Una métrica de la card: ícono + valor (Space Grotesk) + label. */
export interface TripStat {
  key: string;
  Icon: React.ComponentType<IconProps>;
  value: string;
  label: string;
}

/**
 * Card gris de métricas de viaje (frame OfferSheet · `RouteCard` del board): N columnas
 * ícono + valor + label separadas por divisores verticales. Componente canónico reusado en
 * TripIncoming (Distancia/Duración/A recojo) y donde el board repite el bloque de decisión —
 * antes se dibujaba inline con un `.map` en cada pantalla.
 */
export interface TripStatsCardProps {
  stats: readonly TripStat[];
  style?: ViewStyle;
}

export function TripStatsCard({ stats, style }: TripStatsCardProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.colors.bg, borderColor: theme.colors.border },
        style,
      ]}
    >
      {stats.map(({ key, Icon, value, label }, i) => (
        <React.Fragment key={key}>
          {i > 0 ? (
            <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
          ) : null}
          <View style={styles.col}>
            <Icon size={16} color={theme.colors.inkMuted} />
            <Text variant="title3" color="ink" tabular style={styles.value}>
              {value}
            </Text>
            <Text variant="footnote" color="inkSubtle" style={styles.label}>
              {label}
            </Text>
          </View>
        </React.Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
  },
  col: { flex: 1, alignItems: 'center', gap: 3 },
  divider: { width: 1, height: 32 },
  value: { fontSize: 16, lineHeight: 20 },
  label: { fontSize: 11, lineHeight: 14 },
});
