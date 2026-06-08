import { useEffect } from 'react';
import { type DimensionValue, type ViewStyle } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../theme/ThemeProvider';
import { useReducedMotion } from '../theme/useReducedMotion';

export type SkeletonVariant = 'rect' | 'circle' | 'text';

export interface SkeletonProps {
  width?: DimensionValue;
  height?: number;
  variant?: SkeletonVariant;
  /** Radio personalizado (ignora variante). */
  radius?: number;
  style?: ViewStyle;
}

/**
 * Placeholder de carga con shimmer (pulso de color entre `skeleton` y `skeletonHighlight`).
 * Respeta reduce-motion (bloque estático). Reserva espacio para evitar layout shift (CLS).
 */
export function Skeleton({ width = '100%', height = 16, variant = 'rect', radius, style }: SkeletonProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      progress.value = 0;
      return;
    }
    progress.value = withRepeat(withTiming(1, { duration: 900 }), -1, true);
  }, [reduced, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      progress.value,
      [0, 1],
      [theme.colors.skeleton, theme.colors.skeletonHighlight],
    ),
  }));

  const resolvedRadius =
    radius ?? (variant === 'circle' ? height / 2 : variant === 'text' ? 4 : theme.radii.sm);

  return (
    <Animated.View
      accessibilityLabel="Cargando"
      accessibilityRole="progressbar"
      style={[
        {
          width: variant === 'circle' ? height : width,
          height,
          borderRadius: resolvedRadius,
        },
        animatedStyle,
        style,
      ]}
    />
  );
}
