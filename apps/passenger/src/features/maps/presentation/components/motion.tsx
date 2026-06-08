import React, { useEffect } from 'react';
import type { ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useReducedMotion, useTheme } from '@veo/ui-kit';

const MAX_STAGGER_STEPS = 6;

export interface EnterViewProps {
  children: React.ReactNode;
  index?: number;
  delay?: number;
  offsetY?: number;
  style?: ViewStyle;
}

/**
 * Entrada con fade + desplazamiento sutil (ease-out, tokens `motion`). Respeta reduce-motion.
 * Solo anima opacity/transform.
 */
export function EnterView({ children, index = 0, delay, offsetY = 10, style }: EnterViewProps) {
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
    transform: [{ translateY: (1 - progress.value) * offsetY }],
  }));

  return <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>;
}

export interface SelectionBumpProps {
  children: React.ReactNode;
  /** Cuando pasa a true, hace un "pop" sutil (resorte) para confirmar la selección. */
  selected: boolean;
  index?: number;
  style?: ViewStyle;
}

/**
 * Envuelve una opción seleccionable y, al volverse seleccionada, da un rebote sutil de escala
 * (resorte `bouncy`) que acompaña el highlight lima. Combina entrada escalonada al aparecer.
 * Respeta reduce-motion (sin transform).
 */
export function SelectionBump({ children, selected, index = 0, style }: SelectionBumpProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const enter = useSharedValue(0);
  const scale = useSharedValue(1);

  const resolvedDelay = Math.min(index, MAX_STAGGER_STEPS) * 40;

  useEffect(() => {
    if (reduced) {
      enter.value = 1;
      return;
    }
    enter.value = withDelay(
      resolvedDelay,
      withTiming(1, {
        duration: theme.motion.duration.base,
        easing: Easing.bezier(...theme.motion.easing.standard),
      }),
    );
  }, [reduced, resolvedDelay, enter, theme]);

  useEffect(() => {
    if (reduced || !selected) return;
    scale.value = withSpring(1.02, theme.motion.spring.bouncy, () => {
      scale.value = withSpring(1, theme.motion.spring.default);
    });
  }, [selected, reduced, scale, theme]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{ translateY: (1 - enter.value) * 10 }, { scale: scale.value }],
  }));

  return <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>;
}
