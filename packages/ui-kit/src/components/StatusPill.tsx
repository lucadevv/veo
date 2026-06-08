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
import { type ThemeColors } from '../tokens/themes';
import { hexAlpha } from './internal/color';
import { Text } from './Text';

export type StatusTone = 'neutral' | 'brand' | 'accent' | 'safe' | 'success' | 'warn' | 'danger';

export interface StatusPillProps {
  label: string;
  tone?: StatusTone;
  /** Muestra un punto de color a la izquierda. */
  dot?: boolean;
  /** Punto pulsante (estado "en vivo"). Implica `dot`. Respeta reduce-motion. */
  live?: boolean;
  style?: ViewStyle;
}

const toneToColor: Record<StatusTone, keyof ThemeColors> = {
  neutral: 'inkMuted',
  brand: 'brand',
  accent: 'accent',
  safe: 'safe',
  success: 'success',
  warn: 'warn',
  danger: 'danger',
};

/**
 * Etiqueta de estado compacta. El color nunca es el único indicador: usa texto y, opcionalmente,
 * un punto (con pulso para "en vivo"). Fondo tintado del tono, texto del tono para contraste.
 */
export function StatusPill({ label, tone = 'neutral', dot = false, live = false, style }: StatusPillProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const toneColor = theme.colors[toneToColor[tone]];
  const showDot = dot || live;

  const pulse = useSharedValue(1);
  useEffect(() => {
    if (live && !reduced) {
      pulse.value = withRepeat(
        withSequence(withTiming(0.35, { duration: 700 }), withTiming(1, { duration: 700 })),
        -1,
        false,
      );
    } else {
      pulse.value = 1;
    }
  }, [live, reduced, pulse]);

  const dotStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[
        styles.pill,
        {
          backgroundColor: hexAlpha(toneColor, theme.scheme === 'dark' ? 0.2 : 0.14),
          borderRadius: theme.radii.pill,
        },
        style,
      ]}
    >
      {showDot ? (
        <Animated.View style={[styles.dot, { backgroundColor: toneColor }, live ? dotStyle : null]} />
      ) : null}
      <Text variant="label" color={toneToColor[tone]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  dot: { width: 7, height: 7, borderRadius: 999 },
});
