import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../theme/ThemeProvider';
import { useReducedMotion } from '../theme/useReducedMotion';
import { fontFamily } from '../tokens/typography';
import { Text } from './Text';

export interface LiveBadgeProps {
  /** Texto del badge (i18n, resuelto por la app): p. ej. "EN VIVO". */
  label: string;
  /** Etiqueta accesible; por defecto usa `label`. Dot e ícono son decorativos. */
  accessibilityLabel?: string;
}

/** Videocámara (lucide `video`) — el glifo que dice QUÉ está en vivo: el video del habitáculo. Decorativa. */
function VideoGlyph({ color, size }: { color: string; size: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Rect x={2} y={6} width={14} height={12} rx={2} stroke={color} strokeWidth={2} />
    </Svg>
  );
}

/**
 * Pill "EN VIVO" sobre el mapa del viaje activo — FIEL al frame `RecPill` del design/veo.pen (ed6D3):
 * card BLANCA (`surface`) con borde `border` 1px y radio pill, dot 8 + glifo de VIDEO 15 (lucide `video`)
 * ambos en `danger`, label Outfit SemiBold 12 en `ink`, gap 7 y padding 13×9. La sombra del frame se rinde
 * con el token `level2`. El punto PULSA suave (~2s, opacidad + halo en escala) en el UI thread (reanimated,
 * sin timers JS) — decorativo, el frame es estático.
 *
 * COMPARTIDO (passenger + driver): la MISMA identidad de "cámara en vivo" en ambos viajes activos. El label
 * lo pasa la app (i18n), el resto sale del theme (cero hex inline).
 *
 * COLOR — deliberado, NO tocar a verde: dot y videocámara son `danger` (ROJO) porque su semántica es
 * REC/grabación (la cámara del habitáculo transmite), el código universal de "estás siendo grabado".
 */
export function LiveBadge({ label, accessibilityLabel }: LiveBadgeProps): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();

  // Pulso del punto: 0→1→0 en loop (~2s total). Maneja opacidad del dot y el halo (escala + fade).
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (reduced) {
      cancelAnimation(pulse);
      pulse.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1_000, easing: Easing.inOut(Easing.quad) }),
        withTiming(0, { duration: 1_000, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(pulse);
  }, [reduced, pulse]);

  const dotStyle = useAnimatedStyle(() => ({
    opacity: interpolate(pulse.value, [0, 1], [0.55, 1]),
  }));
  const haloStyle = useAnimatedStyle(() => ({
    opacity: interpolate(pulse.value, [0, 1], [0.4, 0]),
    transform: [{ scale: interpolate(pulse.value, [0, 1], [1, 2.4]) }],
  }));

  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel ?? label}
      style={[
        styles.pill,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.pill,
          ...theme.elevation.level2,
        },
      ]}
    >
      <View
        style={styles.dotWrap}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        <Animated.View
          style={[styles.halo, { backgroundColor: theme.colors.danger, borderRadius: 999 }, haloStyle]}
        />
        <Animated.View
          style={[styles.dot, { backgroundColor: theme.colors.danger, borderRadius: 999 }, dotStyle]}
        />
      </View>
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <VideoGlyph color={theme.colors.danger} size={15} />
      </View>
      <Text variant="caption" color="ink" style={styles.label}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Números EXACTOS del frame RecPill (ed6D3): gap 7, padding [9,13], stroke 1.
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 7,
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderWidth: 1,
  },
  label: { fontFamily: fontFamily.textSemibold, fontWeight: '600' },
  dotWrap: { width: 8, height: 8, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8 },
  halo: { position: 'absolute', width: 8, height: 8 },
});
