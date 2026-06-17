import { useEffect } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../theme/ThemeProvider';
import { useReducedMotion } from '../theme/useReducedMotion';
import { MarkerGlyph, type MarkerKind } from './internal/MarkerGlyph';

export type RoutePinVariant = MarkerKind;

export interface RoutePinProps {
  /** `origin` = anillo · `destination` = punto sólido · `user` = ubicación · `stop` = parada intermedia. */
  variant?: RoutePinVariant;
  size?: number;
  /** Halo pulsante (sólo tiene sentido para `user`/"en vivo"). Respeta reduce-motion. */
  pulse?: boolean;
  style?: ViewStyle;
}

/**
 * Marcador de mapa lima (origen/destino/usuario) como vista RN. Lo coloca la app dentro de su
 * capa de markers (MapLibre/react-native-maps). Para la polyline usa los tokens `passengerMapRoute`.
 */
export function RoutePin({ variant = 'origin', size = 16, pulse = false, style }: RoutePinProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    if (pulse && !reduced) {
      progress.value = withRepeat(
        withSequence(withTiming(1, { duration: 1100 }), withTiming(0, { duration: 0 })),
        -1,
        false,
      );
    } else {
      progress.value = 0;
    }
  }, [pulse, reduced, progress]);

  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.45 * (1 - progress.value),
    transform: [{ scale: 1 + progress.value * 1.6 }],
  }));

  return (
    <View style={[styles.center, { width: size * 2.6, height: size * 2.6 }, style]}>
      {pulse ? (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: theme.colors.brand,
            },
            haloStyle,
          ]}
        />
      ) : null}
      <MarkerGlyph kind={variant} size={size} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});
