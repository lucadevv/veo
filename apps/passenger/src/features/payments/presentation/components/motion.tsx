import React, {useCallback, useEffect} from 'react';
import {StyleSheet, type ViewStyle} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import {Text, useReducedMotion, useTheme} from '@veo/ui-kit';

const MAX_STAGGER_STEPS = 6;

export interface EnterViewProps {
  children: React.ReactNode;
  index?: number;
  delay?: number;
  offsetY?: number;
  style?: ViewStyle;
}

/** Entrada con fade + desplazamiento sutil (ease-out). Respeta reduce-motion. */
export function EnterView({
  children,
  index = 0,
  delay,
  offsetY = 10,
  style,
}: EnterViewProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);

  const resolvedDelay = delay ?? Math.min(index, MAX_STAGGER_STEPS) * 40;

  useEffect(() => {
    if (reduced) {
      progress.value = 1;
      return;
    }
    progress.value = withDelay(
      resolvedDelay,
      withTiming(1, {
        duration: theme.motion.duration.base,
        easing: Easing.bezier(...theme.motion.easing.standard),
      }),
    );
  }, [reduced, resolvedDelay, progress, theme]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{translateY: (1 - progress.value) * offsetY}],
  }));

  return (
    <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>
  );
}

/**
 * Feedback de press: escala sutil (0.97) interrumpible. Respeta reduce-motion (sin transform).
 * Para `Pressable` propios (chips) que no usan los componentes del kit.
 */
export function usePressScale(scaleTo?: number) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const scale = useSharedValue(1);
  const target = scaleTo ?? theme.motion.scale.press;

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{scale: scale.value}],
  }));

  const onPressIn = useCallback(() => {
    if (reduced) return;
    scale.value = withTiming(target, {
      duration: theme.motion.duration.fast,
      easing: Easing.bezier(...theme.motion.easing.standard),
    });
  }, [reduced, target, theme, scale]);

  const onPressOut = useCallback(() => {
    if (reduced) return;
    scale.value = withTiming(1, {
      duration: theme.motion.exit.base,
      easing: Easing.bezier(...theme.motion.easing.standard),
    });
  }, [reduced, theme, scale]);

  return {animatedStyle, onPressIn, onPressOut};
}

// SuccessCheck ahora es el CANÓNICO de @veo/ui-kit (círculo verde + check negro + pop) — antes había una
// copia local (círculo + ✓ tipográfico) duplicada en payments/ratings/profile. Re-export para no tocar los
// consumidores de este módulo.
export {SuccessCheck, type SuccessCheckProps} from '@veo/ui-kit';

/** Reexport para envolver contenido presionable con estilo animado. */
export {Animated};
