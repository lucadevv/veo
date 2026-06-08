import React, { useCallback, useEffect } from 'react';
import type { ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useReducedMotion, useTheme } from '@veo/ui-kit';

/** Tope de stagger para que listas largas no demoren la última fila. */
const MAX_STAGGER_STEPS = 6;

export interface EnterViewProps {
  children: React.ReactNode;
  /** Índice del elemento en una lista; deriva el retraso de stagger (~40ms). */
  index?: number;
  /** Retraso explícito en ms (gana sobre `index`). */
  delay?: number;
  /** Desplazamiento vertical inicial en px (solo transform, sin layout shift). */
  offsetY?: number;
  style?: ViewStyle;
}

/**
 * Entrada con fade + desplazamiento sutil (ease-out, tokens `motion`). Respeta reduce-motion
 * (estado final inmediato). Solo anima opacity/transform. Pensado para secciones y filas de lista.
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

/**
 * Feedback de press: escala sutil (0.97) interrumpible. Respeta reduce-motion (sin transform).
 * Para `Pressable` propios (chips/atajos) que no usan los componentes del kit.
 */
export function usePressScale(scaleTo?: number) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const scale = useSharedValue(1);
  const target = scaleTo ?? theme.motion.scale.press;

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

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

  return { animatedStyle, onPressIn, onPressOut };
}

/** Reexport para envolver contenido presionable con estilo animado. */
export { Animated };
