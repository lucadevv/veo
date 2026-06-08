import { useEffect } from 'react';
import { Pressable, type PressableProps, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../theme/ThemeProvider';
import { useReducedMotion } from '../theme/useReducedMotion';
import { hexAlpha } from './internal/color';
import { Animated as PressAnimated, usePressScale } from './internal/usePressScale';
import { Text } from './Text';

export interface SosButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  /** Texto del botón (≤4 caracteres). Por defecto "SOS". */
  label?: string;
  /** Diámetro (px). */
  size?: number;
  /** Halo pulsante para señalar emergencia activa. Respeta reduce-motion. */
  pulse?: boolean;
  accessibilityLabel?: string;
  disabled?: boolean;
  style?: ViewStyle;
}

/**
 * Botón redondo de emergencia. Rojo `danger` con texto `onDanger` bold. Feedback de press fuerte
 * (scale 0.95). Halo pulsante opcional para estado de pánico activo (no es el único indicador:
 * el texto "SOS" siempre está presente).
 */
export function SosButton({
  label = 'SOS',
  size = 64,
  pulse = false,
  accessibilityLabel,
  disabled = false,
  style,
  onPress,
  ...rest
}: SosButtonProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const { animatedStyle, onPressIn, onPressOut } = usePressScale(theme.motion.scale.pressStrong);

  const halo = useSharedValue(0);
  useEffect(() => {
    if (pulse && !reduced) {
      halo.value = withRepeat(
        withSequence(withTiming(1, { duration: 900 }), withTiming(0, { duration: 0 })),
        -1,
        false,
      );
    } else {
      halo.value = 0;
    }
  }, [pulse, reduced, halo]);

  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.5 * (1 - halo.value),
    transform: [{ scale: 1 + halo.value * 0.6 }],
  }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? 'Emergencia'}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={styles.pressable}
      {...rest}
    >
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        {pulse ? (
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { borderRadius: size / 2, backgroundColor: hexAlpha(theme.colors.danger, 1) },
              haloStyle,
            ]}
          />
        ) : null}
        <PressAnimated.View
          style={[
            styles.circle,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: theme.colors.danger,
              opacity: disabled ? 0.45 : 1,
              ...theme.elevation.level2,
            },
            animatedStyle,
            style,
          ]}
        >
          <Text variant="title3" color="onDanger" numberOfLines={1}>
            {label}
          </Text>
        </PressAnimated.View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: { alignSelf: 'flex-start' },
  circle: { alignItems: 'center', justifyContent: 'center' },
});
