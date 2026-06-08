import React, { useEffect } from 'react';
import type { ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useReducedMotion, useTheme } from '@veo/ui-kit';

/** Tope de pasos de stagger para que listas largas no acumulen retrasos perceptibles. */
const MAX_STAGGER_STEPS = 8;

export interface FadeInViewProps {
  children: React.ReactNode;
  /** Índice para escalonar la entrada (stagger automático de ~50ms por paso). */
  index?: number;
  /** Override del retraso (ms). Tiene prioridad sobre `index`. */
  delay?: number;
  /** Desplazamiento vertical inicial (px). Nunca aparece "desde la nada". */
  offsetY?: number;
  /** Duración de entrada (ms). Por defecto `motion.duration.base`. */
  duration?: number;
  style?: ViewStyle | ViewStyle[];
}

/**
 * Entrada con fade + desplazamiento sutil (ease-out, tokens `motion`). Respeta reduce-motion
 * (aparece sin transform). Solo anima opacity/transform (GPU). Es el bloque base de las
 * entradas escalonadas del flujo de ingreso.
 */
export function FadeInView({
  children,
  index = 0,
  delay,
  offsetY = 12,
  duration,
  style,
}: FadeInViewProps): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);

  const resolvedDelay = delay ?? Math.min(index, MAX_STAGGER_STEPS) * 50;

  useEffect(() => {
    if (reduced) {
      progress.value = 1;
      return;
    }
    progress.value = withDelay(
      resolvedDelay,
      withTiming(1, {
        duration: duration ?? theme.motion.duration.base,
        easing: Easing.bezier(...theme.motion.easing.standard),
      }),
    );
  }, [reduced, resolvedDelay, duration, progress, theme]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * offsetY }],
  }));

  return <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>;
}
