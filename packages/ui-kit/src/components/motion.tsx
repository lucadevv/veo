import React, { type ReactNode, useEffect } from 'react';
import {
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeInDown,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../theme/ThemeProvider';
import { useReducedMotion } from '../theme/useReducedMotion';

/**
 * Primitivas de movimiento CANÓNICAS del design system (lenguaje "Midnight Motion"). Antes vivían
 * duplicadas (md5-idénticas) en el `motion.tsx` de cada feature de las apps; ahora son una sola fuente
 * aquí. Todas respetan reduce-motion y solo animan transform/opacity (GPU), sin layout shift.
 */

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface AppearProps {
  children: ReactNode;
  /** Retardo de entrada (ms) para escalonar (stagger). */
  delay?: number;
  /** Desplazamiento vertical inicial (px). */
  distance?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Entrada fade + translateY con ease-out (tokens `theme.motion`). Degrada a fade puro con
 * reduce-motion (sin movimiento de posición). Solo anima transform/opacity (GPU).
 */
export function Appear({
  children,
  delay = 0,
  distance = 10,
  style,
}: AppearProps): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const { duration, easing } = theme.motion;
  const entering = reduced
    ? FadeIn.duration(duration.base).delay(delay)
    : FadeInDown.duration(duration.slow)
        .delay(delay)
        .easing(Easing.bezierFn(...easing.standard))
        .withInitialValues({ opacity: 0, transform: [{ translateY: distance }] });
  return (
    <Animated.View entering={entering} style={style}>
      {children}
    </Animated.View>
  );
}

export interface PressableScaleProps extends Omit<PressableProps, 'style'> {
  children: ReactNode;
  /** Escala objetivo al presionar (por defecto `theme.motion.scale.press`). */
  scaleTo?: number;
  /** Estilo base del presionable. */
  style?: StyleProp<ViewStyle>;
  /** Estilo extra aplicado mientras está presionado (p. ej. fondo). */
  pressedStyle?: StyleProp<ViewStyle>;
}

/**
 * Presionable con feedback de escala 0.97 + opacidad (ease-out, interrumpible). Respeta
 * reduce-motion (sin transform). Solo anima transform/opacity, sin layout shift.
 */
export function PressableScale({
  children,
  scaleTo,
  style,
  pressedStyle,
  onPressIn,
  onPressOut,
  ...rest
}: PressableScaleProps): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const target = scaleTo ?? theme.motion.scale.press;
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const handlePressIn = (event: GestureResponderEvent) => {
    if (!reduced) {
      const config = {
        duration: theme.motion.duration.fast,
        easing: Easing.bezier(...theme.motion.easing.standard),
      };
      scale.value = withTiming(target, config);
      opacity.value = withTiming(0.92, config);
    }
    onPressIn?.(event);
  };

  const handlePressOut = (event: GestureResponderEvent) => {
    if (!reduced) {
      const config = {
        duration: theme.motion.exit.base,
        easing: Easing.bezier(...theme.motion.easing.standard),
      };
      scale.value = withTiming(1, config);
      opacity.value = withTiming(1, config);
    }
    onPressOut?.(event);
  };

  return (
    <AnimatedPressable
      {...rest}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={({ pressed }) => [animatedStyle, style, pressed ? pressedStyle : null]}
    >
      {children}
    </AnimatedPressable>
  );
}

export interface PulseProps {
  /** Activa el latido (p. ej. solo cuando el conductor está en línea). */
  active: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Duración de un ciclo de respiración (ms). */
  period?: number;
  /** Opacidad mínima del ciclo. */
  minOpacity?: number;
  /** Opacidad máxima del ciclo. */
  maxOpacity?: number;
  /** Escala máxima del ciclo (la mínima es 1). */
  maxScale?: number;
}

/**
 * "Respiración" sutil (opacidad + escala) en bucle para señalar un estado vivo (en línea). Se
 * detiene y queda en reposo con reduce-motion o cuando `active` es falso. Solo transform/opacity.
 */
export function Pulse({
  active,
  children,
  style,
  period = 1600,
  minOpacity = 0.55,
  maxOpacity = 1,
  maxScale = 1.08,
}: PulseProps): React.JSX.Element {
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reduced || !active) {
      cancelAnimation(progress);
      progress.value = withTiming(0, { duration: 160 });
      return;
    }
    progress.value = withRepeat(
      withTiming(1, { duration: period, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => cancelAnimation(progress);
  }, [active, reduced, period, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [maxOpacity, minOpacity]),
    transform: [{ scale: interpolate(progress.value, [0, 1], [1, maxScale]) }],
  }));

  return <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>;
}
