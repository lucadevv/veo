import { hexAlpha, useReducedMotion, useTheme } from '@veo/ui-kit';
import React, { useEffect } from 'react';
import { type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';

export interface RouteMotifProps {
  /** Ancho del lienzo del motivo (px). */
  width: number;
  /** Alto del lienzo (px). Por defecto 64. */
  height?: number;
  /** Si el motivo se "desliza" y aparece al montar (respeta reduce-motion). */
  animated?: boolean;
  /** Color de la línea (por defecto `brand`/lima). */
  color?: string;
  style?: ViewStyle;
}

/** Lienzo de referencia: la curva y el pin están definidos en estas coordenadas y escalan con el SVG. */
const VIEW_W = 200;
const VIEW_H = 64;
/** Curva que sube de izquierda (origen) a derecha (pin de destino), lenguaje "Midnight Motion". */
const ROUTE_PATH = 'M12 48 C 56 48, 78 20, 120 18 S 176 14, 188 14';
const PIN = { x: 188, y: 14 } as const;
const ORIGIN = { x: 12, y: 48 } as const;

/**
 * Motivo de marca "ruta lima con glow": un origen anular a la izquierda, una traza punteada que
 * ondula hacia la derecha bajo un halo translúcido, y un pin de destino al final. Es puramente
 * decorativo (`pointerEvents="none"`) y se dibuja con `react-native-svg` para trazos nítidos a
 * cualquier escala. Con `animated`, el grupo aparece deslizándose (solo opacity/transform, GPU),
 * respetando reduce-motion.
 *
 * Vive en `shared` (no en una feature) porque es un átomo de identidad de marca reutilizado por el
 * wordmark (`VeoWordmark`) y por las pantallas del flujo de ingreso.
 */
export function RouteMotif({
  width,
  height = 64,
  animated = false,
  color,
  style,
}: RouteMotifProps): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const line = color ?? theme.colors.brand;
  const glow = hexAlpha(line, 0.22);

  const progress = useSharedValue(animated && !reduced ? 0 : 1);

  useEffect(() => {
    if (!animated || reduced) {
      progress.value = 1;
      return;
    }
    progress.value = withTiming(1, {
      duration: theme.motion.duration.slow,
      easing: Easing.bezier(...theme.motion.easing.standard),
    });
  }, [animated, reduced, progress, theme]);

  // Entrada del grupo: fade + deslizamiento sutil desde la izquierda (la ruta "llega").
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateX: (1 - progress.value) * -10 }],
  }));

  return (
    <Animated.View pointerEvents="none" style={[{ width, height }, animatedStyle, style]}>
      <Svg
        width={width}
        height={height}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        pointerEvents="none"
      >
        {/* Halo translúcido bajo la traza. */}
        <Path d={ROUTE_PATH} stroke={glow} strokeWidth={12} strokeLinecap="round" fill="none" />
        {/* Traza punteada lima (dots). */}
        <Path
          d={ROUTE_PATH}
          stroke={line}
          strokeWidth={3.5}
          strokeLinecap="round"
          strokeDasharray="0.5 10"
          fill="none"
        />
        {/* Origen: anillo hueco lima sobre el fondo. */}
        <Circle cx={ORIGIN.x} cy={ORIGIN.y} r={5} stroke={line} strokeWidth={3} fill={theme.colors.bg} />
        {/* Pin de destino: punto lima + halo. */}
        <Circle cx={PIN.x} cy={PIN.y} r={11} stroke={glow} strokeWidth={2} fill="none" />
        <Circle cx={PIN.x} cy={PIN.y} r={6} fill={line} />
      </Svg>
    </Animated.View>
  );
}
