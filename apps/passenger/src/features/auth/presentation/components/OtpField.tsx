import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Text, useReducedMotion, useTheme } from '@veo/ui-kit';

export interface OtpFieldProps {
  value: string;
  onChangeText: (next: string) => void;
  /** Longitud del código. Por defecto 6. */
  length?: number;
  hasError: boolean;
  /** Cambia su valor para disparar el "shake" (p. ej. contador de errores de verificación). */
  errorNonce?: number;
  accessibilityLabel: string;
}

interface BoxProps {
  char: string;
  active: boolean;
  hasError: boolean;
}

/** Casilla individual del OTP: caret lima parpadeante cuando está activa y vacía. */
function OtpBox({ char, active, hasError }: BoxProps): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const caret = useSharedValue(1);

  useEffect(() => {
    if (!active || char || reduced) {
      caret.value = active && !char ? 1 : 0;
      return;
    }
    caret.value = withRepeat(
      withTiming(0, { duration: 520, easing: Easing.bezier(...theme.motion.easing.inOut) }),
      -1,
      true,
    );
  }, [active, char, reduced, caret, theme]);

  const caretStyle = useAnimatedStyle(() => ({ opacity: caret.value }));

  const borderColor = hasError
    ? theme.colors.danger
    : active
      ? theme.colors.accent
      : char
        ? theme.colors.borderStrong
        : theme.colors.border;

  return (
    <View
      style={[
        styles.box,
        {
          backgroundColor: theme.colors.surfaceElevated,
          borderColor,
          borderWidth: active || hasError ? 2 : 1,
          borderRadius: theme.radii.md,
        },
      ]}
    >
      {char ? (
        <Text variant="title1" tabular>
          {char}
        </Text>
      ) : active ? (
        <Animated.View
          style={[styles.caret, { backgroundColor: theme.colors.accent }, caretStyle]}
        />
      ) : null}
    </View>
  );
}

/**
 * Campo OTP de casillas individuales. Un TextInput oculto conserva la lógica de estado (mismos
 * props de autocompletado/teclado); las cajas solo reflejan los dígitos. Microinteracciones: foco
 * animado (caret lima parpadeante), "shake" en error. Respeta reduce-motion.
 */
export function OtpField({
  value,
  onChangeText,
  length = 6,
  hasError,
  errorNonce = 0,
  accessibilityLabel,
}: OtpFieldProps): React.JSX.Element {
  const reduced = useReducedMotion();
  const theme = useTheme();
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const shake = useSharedValue(0);

  // Dispara el "shake" cuando cambia el nonce de error (un intento fallido nuevo).
  useEffect(() => {
    if (errorNonce <= 0 || reduced) {
      return;
    }
    shake.value = withSequence(
      withTiming(-8, { duration: 50 }),
      withTiming(8, { duration: 50 }),
      withTiming(-6, { duration: 50 }),
      withTiming(6, { duration: 50 }),
      withTiming(0, { duration: 50 }),
    );
  }, [errorNonce, reduced, shake]);

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));

  return (
    <Pressable onPress={() => inputRef.current?.focus()}>
      <Animated.View style={[styles.row, { gap: theme.spacing.sm }, rowStyle]}>
        {Array.from({ length }).map((_, index) => {
          const char = value[index] ?? '';
          const active =
            focused && (index === value.length || (value.length >= length && index === length - 1));
          return <OtpBox key={index} char={char} active={active} hasError={hasError} />;
        })}
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={onChangeText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          keyboardType="number-pad"
          autoComplete="sms-otp"
          textContentType="oneTimeCode"
          maxLength={length}
          autoFocus
          caretHidden
          accessibilityLabel={accessibilityLabel}
          style={styles.hiddenInput}
        />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  box: { flex: 1, aspectRatio: 0.82, alignItems: 'center', justifyContent: 'center' },
  caret: { width: 2, height: 28, borderRadius: 1 },
  hiddenInput: { ...StyleSheet.absoluteFillObject, opacity: 0 },
});
