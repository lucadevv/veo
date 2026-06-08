import React, {type ReactNode, useEffect, useRef, useState} from 'react';
import {
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {useReducedMotion, useTheme} from '@veo/ui-kit';

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
export function Appear({children, delay = 0, distance = 10, style}: AppearProps): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const {duration, easing} = theme.motion;
  const entering = reduced
    ? FadeIn.duration(duration.base).delay(delay)
    : FadeInDown.duration(duration.slow)
        .delay(delay)
        .easing(Easing.bezierFn(...easing.standard))
        .withInitialValues({opacity: 0, transform: [{translateY: distance}]});
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
    transform: [{scale: scale.value}],
    opacity: opacity.value,
  }));

  const handlePressIn = (event: GestureResponderEvent) => {
    if (!reduced) {
      const config = {duration: theme.motion.duration.fast, easing: Easing.bezier(...theme.motion.easing.standard)};
      scale.value = withTiming(target, config);
      opacity.value = withTiming(0.92, config);
    }
    onPressIn?.(event);
  };

  const handlePressOut = (event: GestureResponderEvent) => {
    if (!reduced) {
      const config = {duration: theme.motion.exit.base, easing: Easing.bezier(...theme.motion.easing.standard)};
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
      style={({pressed}) => [animatedStyle, style, pressed ? pressedStyle : null]}>
      {children}
    </AnimatedPressable>
  );
}

/**
 * Cuenta ascendente sutil de un valor entero (p. ej. céntimos) con ease-out cúbico sobre ~700ms.
 * Respeta reduce-motion: si está activo (o `enabled` es falso) devuelve el valor final al instante.
 * El consumidor formatea el número intermedio (p. ej. con `formatPEN`).
 */
export function useCountUp(target: number, enabled = true): number {
  const reduced = useReducedMotion();
  const [value, setValue] = useState(() => (reduced || !enabled ? target : 0));
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduced || !enabled || !Number.isFinite(target)) {
      setValue(target);
      return;
    }
    const from = 0;
    const duration = 700;
    const start = Date.now();
    const tick = () => {
      const progress = Math.min(1, (Date.now() - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [target, enabled, reduced]);

  return value;
}
