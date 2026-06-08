import React, {type ReactNode, useEffect} from 'react';
import {type LayoutChangeEvent, StyleSheet, View, type StyleProp, type ViewStyle} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {useReducedMotion, useTheme} from '@veo/ui-kit';

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

export interface AnimatedBarProps {
  /** Fracción de relleno (0..1). */
  fraction: number;
  /** Color del relleno. */
  color: string;
  /** Color de la pista. */
  trackColor: string;
  /** Alto de la barra (px). */
  height?: number;
  /** Radio de las esquinas. */
  radius?: number;
  /** Etiqueta de accesibilidad del progreso (porcentaje 0..100). */
  percent?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Barra de progreso que se rellena con un crecimiento anclado a la izquierda. Solo anima transform
 * (scaleX + translateX a partir del ancho medido), nunca `width` (sin reflow). Respeta reduce-motion
 * mostrando el valor final al instante.
 */
export function AnimatedBar({
  fraction,
  color,
  trackColor,
  height = 10,
  radius = 999,
  percent,
  style,
}: AnimatedBarProps): React.JSX.Element {
  const reduced = useReducedMotion();
  const theme = useTheme();
  const clamped = Math.min(1, Math.max(0, fraction));
  const width = useSharedValue(0);
  const progress = useSharedValue(reduced ? clamped : 0);

  useEffect(() => {
    if (reduced) {
      progress.value = clamped;
      return;
    }
    progress.value = withTiming(clamped, {
      duration: theme.motion.duration.slower,
      easing: Easing.bezier(...theme.motion.easing.standard),
    });
  }, [clamped, reduced, progress, theme]);

  const onLayout = (event: LayoutChangeEvent) => {
    width.value = event.nativeEvent.layout.width;
  };

  const fillStyle = useAnimatedStyle(() => {
    const p = Math.max(progress.value, 0.0001);
    return {
      transform: [{translateX: -(width.value * (1 - p)) / 2}, {scaleX: p}],
    };
  });

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={percent !== undefined ? {min: 0, max: 100, now: percent} : undefined}
      onLayout={onLayout}
      style={[styles.track, {backgroundColor: trackColor, height, borderRadius: radius}, style]}>
      <Animated.View style={[styles.fill, {backgroundColor: color, borderRadius: radius}, fillStyle]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {width: '100%', overflow: 'hidden'},
  fill: {...StyleSheet.absoluteFillObject},
});
