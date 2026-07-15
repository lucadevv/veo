import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { hexAlpha, Text, useTheme } from '@veo/ui-kit';

export interface RadioOptionCardProps {
  /** Etiqueta del motivo (ya traducida). */
  label: string;
  /** true si es la opción elegida (borde/relleno de marca + punto lleno). */
  selected: boolean;
  onPress: () => void;
}

/**
 * Tarjeta de opción con radio (frame/componente `A/ReasonCard` + `A/Radio` del `.pen`): fila
 * presionable con un control radio a la izquierda y la etiqueta a la derecha. Seleccionada = borde y
 * relleno de marca (`brand` + `brand-dim`) con el punto lleno; sin seleccionar = superficie con borde
 * neutro y el anillo `border-strong` vacío. Un solo componente reutilizable (sin copy-paste por fila).
 */
export function RadioOptionCard({
  label,
  selected,
  onPress,
}: RadioOptionCardProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={[
        styles.card,
        {
          borderRadius: theme.radii.lg,
          backgroundColor: selected ? hexAlpha(theme.colors.brand, 0.15) : theme.colors.surface,
          borderColor: selected ? theme.colors.brand : theme.colors.border,
        },
      ]}
    >
      <View
        style={[
          styles.radio,
          { borderColor: selected ? theme.colors.brand : theme.colors.borderStrong },
        ]}
      >
        {selected ? (
          <View style={[styles.dot, { backgroundColor: theme.colors.brand }]} />
        ) : null}
      </View>
      <Text variant="subhead" style={styles.label} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderWidth: 1,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 999,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 9, height: 9, borderRadius: 999 },
  label: { flex: 1 },
});
