import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text, useTheme } from '@veo/ui-kit';
import { IconCircle, IconMap } from '../icons';

export interface RouteSummaryCardProps {
  /** Etiqueta del punto de recojo (dirección si el contrato la trae; genérica si no). */
  origin: string;
  /** Etiqueta del destino. */
  destination: string;
  /** Línea de meta bajo la ruta (ej. "8.4 km · ~14 min"). Omitida si no hay dato. */
  meta?: string;
  /** Relleno: `bg` (gris #F5F7FA, sobre sheets blancos — como el board) o `surface` (blanco, sobre el canvas). */
  fill?: 'bg' | 'surface';
  style?: StyleProp<ViewStyle>;
}

/**
 * Card de resumen de ruta (frame C/Puja · bloque `Route` del board): fila de ORIGEN (círculo teal) →
 * fila de DESTINO (pin verde) + línea de meta opcional. Canónica para todo resumen origen→destino
 * del conductor — antes cada pantalla dibujaba su propia versión inline.
 */
export function RouteSummaryCard({
  origin,
  destination,
  meta,
  fill = 'bg',
  style,
}: RouteSummaryCardProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: fill === 'bg' ? theme.colors.bg : theme.colors.surface,
          borderColor: theme.colors.border,
        },
        style,
      ]}
    >
      <View style={styles.row}>
        <IconCircle size={14} color={theme.colors.brand} />
        <Text variant="callout" numberOfLines={1} style={styles.label}>
          {origin}
        </Text>
      </View>
      <View style={styles.row}>
        <IconMap size={14} color={theme.colors.success} />
        <Text variant="callout" numberOfLines={1} style={styles.label}>
          {destination}
        </Text>
      </View>
      {meta ? (
        <Text variant="caption" color="inkSubtle">
          {meta}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 8, padding: 14, borderRadius: 16, borderWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  label: { flex: 1, fontSize: 13, lineHeight: 18 },
});
