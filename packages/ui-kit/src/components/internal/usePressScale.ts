import { useCallback } from 'react';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../../theme/ThemeProvider';
import { useReducedMotion } from '../../theme/useReducedMotion';

export interface PressScale {
  /** Estilo animado para envolver el contenido presionable. */
  animatedStyle: ReturnType<typeof useAnimatedStyle>;
  onPressIn: () => void;
  onPressOut: () => void;
}

/**
 * Feedback de press: escala sutil (0.97) con ease-out, interrumpible (transición, no keyframe).
 * Respeta reduce-motion (sin transform). Sólo anima `transform` (GPU).
 */
export function usePressScale(scaleTo?: number): PressScale {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const scale = useSharedValue(1);
  const target = scaleTo ?? theme.motion.scale.press;

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
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

  return { animatedStyle, onPressIn, onPressOut };
}

/** Reexport para componentes que envuelven contenido animado. */
export { Animated };
