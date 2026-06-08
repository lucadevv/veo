import { type ReactNode, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { TOUCH_TARGET } from '../tokens/spacing';
import { Text } from './Text';

export interface TextFieldProps extends Omit<TextInputProps, 'style' | 'placeholderTextColor'> {
  /** Label visible (nunca placeholder-only). */
  label: string;
  /** Texto de ayuda persistente bajo el campo. */
  helperText?: string;
  /** Mensaje de error (reemplaza al helper y se anuncia como alerta). */
  error?: string;
  /** Campo requerido (marca con asterisco). */
  required?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  containerStyle?: ViewStyle;
}

/**
 * Campo de texto VEO. Label visible, helper persistente, error debajo (role alert), foco
 * tematizado y toggle de contraseña. Usa `keyboardType`/`inputMode` semánticos del consumidor.
 */
export function TextField({
  label,
  helperText,
  error,
  required = false,
  leftIcon,
  rightIcon,
  secureTextEntry,
  containerStyle,
  onFocus,
  onBlur,
  ...rest
}: TextFieldProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(Boolean(secureTextEntry));
  const hasError = Boolean(error);

  const borderColor = hasError
    ? theme.colors.danger
    : focused
      ? theme.colors.focus
      : theme.colors.border;

  return (
    <View style={[styles.container, containerStyle]}>
      <View style={styles.labelRow}>
        <Text variant="subhead" color="inkMuted">
          {label}
        </Text>
        {required ? (
          <Text variant="subhead" color="danger">
            {' *'}
          </Text>
        ) : null}
      </View>

      <View
        style={[
          styles.inputRow,
          {
            backgroundColor: theme.colors.surfaceElevated,
            borderColor,
            borderWidth: focused || hasError ? 2 : 1,
            borderRadius: theme.radii.md,
            paddingHorizontal: theme.spacing.lg,
            minHeight: TOUCH_TARGET + 4,
          },
        ]}
      >
        {leftIcon ? <View style={styles.affix}>{leftIcon}</View> : null}
        <TextInput
          accessibilityLabel={label}
          placeholderTextColor={theme.colors.inkSubtle}
          secureTextEntry={hidden}
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
              fontSize: theme.typography.fontSize.base,
              fontFamily: theme.typography.fontFamily.text,
            },
          ]}
          {...rest}
        />
        {secureTextEntry ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={hidden ? 'Mostrar contraseña' : 'Ocultar contraseña'}
            hitSlop={8}
            onPress={() => setHidden((v) => !v)}
            style={styles.affix}
          >
            <Text variant="subhead" color="accent">
              {hidden ? 'Mostrar' : 'Ocultar'}
            </Text>
          </Pressable>
        ) : rightIcon ? (
          <View style={styles.affix}>{rightIcon}</View>
        ) : null}
      </View>

      {hasError ? (
        <Text variant="footnote" color="danger" accessibilityRole="alert" style={styles.help}>
          {error}
        </Text>
      ) : helperText ? (
        <Text variant="footnote" color="inkSubtle" style={styles.help}>
          {helperText}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch', gap: 6 },
  labelRow: { flexDirection: 'row' },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: { flex: 1, paddingVertical: 12 },
  affix: { alignItems: 'center', justifyContent: 'center' },
  help: { marginTop: 2 },
});
