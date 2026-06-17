import React, { type ReactNode, useState } from 'react';
import { StyleSheet, TextInput, type TextInputProps, View, type ViewStyle } from 'react-native';
import { Text, useTheme } from '@veo/ui-kit';

export interface RegistrationFieldProps extends Omit<
  TextInputProps,
  'style' | 'placeholderTextColor'
> {
  /** Etiqueta dentro de la caja (arriba), nunca placeholder-only. */
  label: string;
  /** Ícono de la derecha (ya coloreado por el consumidor). */
  rightIcon?: ReactNode;
  /** Mensaje de error (ya traducido). Resalta el borde y se anuncia bajo el campo. */
  error?: string;
  containerStyle?: ViewStyle;
}

/**
 * Campo del wizard de registro: caja de superficie elevada con la etiqueta arriba y el valor en
 * grande debajo (estilo de los mockups drv-04/05). El borde se resalta en cian al enfocar y en rojo
 * (danger) cuando hay error, con el mensaje bajo el campo (nunca solo color: incluye texto). La
 * etiqueta es visible siempre (accesibilidad) y el `accessibilityLabel` del input la reutiliza.
 */
export function RegistrationField({
  label,
  rightIcon,
  error,
  containerStyle,
  onFocus,
  onBlur,
  ...rest
}: RegistrationFieldProps): React.JSX.Element {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);

  const borderColor = error
    ? theme.colors.danger
    : focused
      ? theme.colors.accent
      : theme.colors.border;

  return (
    <View style={styles.wrap}>
      <View
        style={[
          styles.box,
          {
            backgroundColor: theme.colors.surface,
            borderColor,
            borderWidth: focused || error ? 2 : 1,
            borderRadius: theme.radii.md,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
          },
          containerStyle,
        ]}
      >
        <View style={styles.texts}>
          <Text variant="footnote" color="inkMuted">
            {label}
          </Text>
          <TextInput
            accessibilityLabel={label}
            placeholderTextColor={theme.colors.inkSubtle}
            onFocus={(e) => {
              setFocused(true);
              onFocus?.(e);
            }}
            onBlur={(e) => {
              setFocused(false);
              onBlur?.(e);
            }}
            style={[
              styles.input,
              {
                color: theme.colors.ink,
                fontSize: theme.typography.fontSize.lg,
                fontFamily: theme.typography.fontFamily.text,
                fontWeight: '600',
              },
            ]}
            {...rest}
          />
        </View>
        {rightIcon ? <View style={styles.icon}>{rightIcon}</View> : null}
      </View>
      {error ? (
        <Text
          variant="footnote"
          color="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={styles.error}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch', gap: 6 },
  box: { flexDirection: 'row', alignItems: 'center', gap: 12, alignSelf: 'stretch' },
  texts: { flex: 1, gap: 2 },
  input: { padding: 0, marginTop: 2, minHeight: 28 },
  icon: { alignItems: 'center', justifyContent: 'center' },
  error: { paddingHorizontal: 4 },
});
