import React, { useEffect } from 'react';
import type { StyleProp, ViewProps, ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useTheme, useReducedMotion } from '@veo/ui-kit';

/** Dirección desde la que entra el contenido (nada aparece "de la nada": siempre con opacidad). */
export type RevealFrom = 'bottom' | 'top' | 'scale';

export interface RevealProps extends ViewProps {
  children: React.ReactNode;
  /** Retardo de entrada en ms (para escalonar listas; 30-80ms entre items). */
  delay?: number;
  /** Origen de la entrada. `scale` parte de 0.96 (nunca de 0). */
  from?: RevealFrom;
  /** Desplazamiento inicial en px para `bottom`/`top`. */
  distance?: number;
  /** Usa spring (más "vivo") en vez de timing. */
  spring?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * Entrada animada reutilizable (opacidad + transform en GPU). Respeta reduce-motion degradando a
 * un crossfade suave sin movimiento. Pensado para reveals de primera vista (onboarding, wizard),
 * por eso usa ease-out fuerte del tema y duraciones <300ms (emil-design-eng).
 */
export function Reveal({
  children,
  delay = 0,
  from = 'bottom',
  distance = 14,
  spring = false,
  style,
  ...rest
}: RevealProps): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      progress.value = withDelay(delay, withTiming(1, { duration: theme.motion.duration.base }));
      return;
    }
    progress.value = spring
      ? withDelay(delay, withSpring(1, theme.motion.spring.default))
      : withDelay(
          delay,
          withTiming(1, {
            duration: theme.motion.duration.slow,
            easing: Easing.bezier(...theme.motion.easing.standard),
          }),
        );
  }, [delay, progress, reduced, spring, theme]);

  const animatedStyle = useAnimatedStyle(() => {
    if (reduced) {
      return { opacity: progress.value };
    }
    if (from === 'scale') {
      return { opacity: progress.value, transform: [{ scale: 0.96 + progress.value * 0.04 }] };
    }
    const translate = (1 - progress.value) * distance;
    const translateY = from === 'top' ? -translate : translate;
    return { opacity: progress.value, transform: [{ translateY }] };
  });

  return (
    <Animated.View style={[style, animatedStyle]} {...rest}>
      {children}
    </Animated.View>
  );
}
