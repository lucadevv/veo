import React from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { Text, useTheme } from '@veo/ui-kit';

interface StepperProps {
  /** Etiqueta a la izquierda (ej. "Asientos"). */
  label?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}

/**
 * Control numérico +/− (asientos, cantidades). No existía en el ui-kit; canónico y sobrio: botones circulares
 * de `surface` con borde tenue, valor tabular al centro. El acento se reserva a lo interactivo primario, así que
 * los botones son neutros (no gritan). Respeta min/max deshabilitando el extremo correspondiente.
 */
export function Stepper({ label, value, onChange, min = 0, max = 99 }: StepperProps): React.JSX.Element {
  const theme = useTheme();
  const atMin = value <= min;
  const atMax = value >= max;

  const btnStyle = (disabled: boolean): ViewStyle => ({
    width: 40,
    height: 40,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    opacity: disabled ? 0.4 : 1,
  });

  return (
    <View style={styles.row}>
      {label ? <Text variant="body">{label}</Text> : null}
      <View style={styles.controls}>
        <Pressable
          onPress={() => onChange(Math.max(min, value - 1))}
          disabled={atMin}
          style={btnStyle(atMin)}
          accessibilityRole="button"
          accessibilityLabel="Quitar uno"
        >
          <Text variant="title3">−</Text>
        </Pressable>
        <Text variant="title3" tabular style={styles.value}>
          {value}
        </Text>
        <Pressable
          onPress={() => onChange(Math.min(max, value + 1))}
          disabled={atMax}
          style={btnStyle(atMax)}
          accessibilityRole="button"
          accessibilityLabel="Agregar uno"
        >
          <Text variant="title3">+</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  value: { minWidth: 28, textAlign: 'center' },
});
