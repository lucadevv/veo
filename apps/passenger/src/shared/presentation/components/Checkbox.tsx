import { Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

interface CheckboxProps {
  checked: boolean;
  label: string;
  onToggle: () => void;
}

/**
 * Casilla de verificación accesible y tematizada (sin emojis-icono). El marcado se dibuja con
 * una vista interior rellena del color de acento; el estado va acompañado de texto (a11y).
 */
export function Checkbox({ checked, label, onToggle }: CheckboxProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={onToggle}
      hitSlop={8}
      style={[styles.row, { gap: theme.spacing.md, paddingVertical: theme.spacing.sm }]}
    >
      <View
        style={[
          styles.box,
          {
            borderRadius: theme.radii.sm,
            borderColor: checked ? theme.colors.accent : theme.colors.borderStrong,
            backgroundColor: checked ? theme.colors.accent : 'transparent',
          },
        ]}
      >
        {checked ? (
          <View style={[styles.mark, { backgroundColor: theme.colors.onAccent }]} />
        ) : null}
      </View>
      <Text variant="callout" style={styles.label}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  box: {
    width: 24,
    height: 24,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mark: { width: 10, height: 10, borderRadius: 2 },
  label: { flex: 1 },
});
