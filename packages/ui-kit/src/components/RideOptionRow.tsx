import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { Text } from './Text';

export interface RideOptionRowProps {
  /** Nombre de la categoría (p. ej. "VEO Moto", "VEO XL"). */
  name: string;
  /** Precio ya formateado (p. ej. "S/ 12.50"). Tabular. */
  price: string;
  /** ETA del vehículo (p. ej. "3 min"). */
  eta?: string;
  /** Descripción corta (capacidad, nota). */
  description?: string;
  /** Ícono del vehículo (lo provee el consumidor; ya coloreado). */
  icon?: ReactNode;
  /** Estado seleccionado: resalta con borde lima y superficie elevada. */
  selected?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  style?: ViewStyle;
}

/**
 * Fila de opción de viaje: ícono de vehículo + nombre + ETA + precio. El estado seleccionado se
 * marca con borde lima (2px) + fondo elevado (no sólo color: también el borde refuerza el estado).
 * Feedback de press por cambio de fondo (fila de lista, sin scale).
 */
export function RideOptionRow({
  name,
  price,
  eta,
  description,
  icon,
  selected = false,
  onPress,
  disabled = false,
  style,
}: RideOptionRowProps) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}${eta ? `, ${eta}` : ''}, ${price}`}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: selected ? theme.colors.surfaceElevated : theme.colors.surface,
          borderColor: selected ? theme.colors.brand : theme.colors.border,
          borderWidth: selected ? 2 : 1,
          borderRadius: theme.radii.lg,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.md,
          gap: theme.spacing.lg,
          opacity: disabled ? 0.45 : 1,
        },
        pressed && !selected ? { backgroundColor: theme.colors.surfaceElevated } : null,
        style,
      ]}
    >
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <View style={styles.body}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {name}
        </Text>
        {eta || description ? (
          <Text variant="footnote" color="inkMuted" numberOfLines={1}>
            {[eta, description].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
      </View>
      <Text variant="bodyStrong" color={selected ? 'brand' : 'ink'} tabular numberOfLines={1}>
        {price}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch' },
  icon: { alignItems: 'center', justifyContent: 'center', width: 40, height: 40 },
  body: { flex: 1, gap: 2 },
});
