import { useEffect } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../theme/ThemeProvider';
import { useReducedMotion } from '../theme/useReducedMotion';
import { ELEVATION_SHADOW_COLOR } from '../tokens/themes';

export interface SwitchProps {
  /** Estado actual (controlado). */
  value: boolean;
  /** Cambio solicitado por el usuario. No se llama si `disabled`. */
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: ViewStyle;
}

const TRACK_W = 52;
const TRACK_H = 32;
const THUMB = 26;
const PAD = (TRACK_H - THUMB) / 2;
const TRAVEL = TRACK_W - THUMB - PAD * 2;
const DURATION = 190;

/**
 * Switch on/off animado (track que interpola al accent de marca; thumb que desliza con resorte suave).
 * Controlado, accesible (`role=switch`), respeta reduce-motion (transición instantánea sin animación).
 * Diseño propio del design system: no usa el Switch nativo (inconsistente entre iOS/Android).
 */
export function Switch({
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
  style,
}: SwitchProps): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const progress = useSharedValue(value ? 1 : 0);

  useEffect(() => {
    const to = value ? 1 : 0;
    progress.value = reduced ? to : withTiming(to, { duration: DURATION });
  }, [value, reduced, progress]);

  const offTrack = theme.colors.borderStrong;
  const onTrack = theme.colors.accent;

  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [offTrack, onTrack]),
  }));

  // El thumb crece un pelo al activarse (feedback táctil-visual sutil) y desliza a la derecha.
  const scale = useDerivedValue(() => 1 + progress.value * 0.04);
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * TRAVEL }, { scale: scale.value }],
  }));

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      hitSlop={8}
      onPress={() => onValueChange(!value)}
      style={[{ opacity: disabled ? 0.45 : 1 }, style]}
    >
      <Animated.View style={[styles.track, trackStyle]}>
        {/* Thumb BLANCO: contrasta tanto sobre el track oscuro (off) como sobre el cyan (on). */}
        <Animated.View style={[styles.thumb, thumbStyle]}>
          {/* Punto cyan que aparece encendido = guiño de marca dentro del thumb blanco. */}
          <View style={[styles.dot, { backgroundColor: onTrack, opacity: value ? 1 : 0 }]} />
        </Animated.View>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    width: TRACK_W,
    height: TRACK_H,
    borderRadius: TRACK_H / 2,
    padding: PAD,
    justifyContent: 'center',
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: ELEVATION_SHADOW_COLOR,
    shadowOpacity: 0.25,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
