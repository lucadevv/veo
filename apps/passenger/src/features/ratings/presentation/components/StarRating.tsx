import {useReducedMotion, useTheme} from '@veo/ui-kit';
import React, {useEffect} from 'react';
import {Pressable, StyleSheet, View} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, {Path} from 'react-native-svg';

const STARS = [1, 2, 3, 4, 5] as const;

export interface StarRatingProps {
  /** Estrellas seleccionadas (0 = sin elegir). */
  value: number;
  onChange: (stars: number) => void;
  /** Tamaño del ícono (px). Frame de calificación = 32. */
  size?: number;
  /** Solo lectura (tras enviar la calificación): sin toque ni rebote. */
  readOnly?: boolean;
}

/**
 * Selector de estrellas 1-5. Usa el ícono de estrella lucide (SVG, no el carácter tipográfico ★/☆)
 * del set light Trust del passenger: ámbar (`warn`) sólida las activas, contorno gris
 * (`borderStrong`) las inactivas. Al tocar, la estrella da un rebote sutil (resorte) que respeta
 * reduce-motion. Accesible como control ajustable. En `readOnly` no responde al toque ni anima.
 */
export function StarRating({
  value,
  onChange,
  size = 32,
  readOnly = false,
}: StarRatingProps): React.JSX.Element {
  return (
    <View
      style={styles.row}
      accessibilityRole="adjustable"
      accessibilityValue={{min: 1, max: 5, now: value}}>
      {STARS.map(star => (
        <Star
          key={star}
          star={star}
          active={star <= value}
          size={size}
          readOnly={readOnly}
          onPress={() => onChange(star)}
        />
      ))}
    </View>
  );
}

interface StarProps {
  star: number;
  active: boolean;
  size: number;
  readOnly: boolean;
  onPress: () => void;
}

function Star({
  star,
  active,
  size,
  readOnly,
  onPress,
}: StarProps): React.JSX.Element {
  const reduced = useReducedMotion();
  const theme = useTheme();
  const scale = useSharedValue(1);

  // Rebote al activarse (al tocar esta estrella o una superior); las inactivas vuelven a reposo.
  // En readOnly (o con reduce-motion) no hay rebote.
  useEffect(() => {
    if (reduced || readOnly) {
      scale.value = 1;
      return;
    }
    if (active) {
      scale.value = withSequence(
        withSpring(1.25, theme.motion.spring.bouncy),
        withSpring(1, theme.motion.spring.default),
      );
    } else {
      scale.value = withTiming(1, {duration: theme.motion.exit.base});
    }
  }, [active, reduced, readOnly, scale, theme]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{scale: scale.value}],
  }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${star}`}
      hitSlop={6}
      disabled={readOnly}
      onPress={onPress}
      style={styles.star}>
      <Animated.View style={animatedStyle}>
        <StarGlyph
          size={size}
          filled={active}
          color={active ? theme.colors.warn : theme.colors.borderStrong}
        />
      </Animated.View>
    </Pressable>
  );
}

interface StarGlyphProps {
  size: number;
  filled: boolean;
  color: string;
}

/**
 * Estrella lucide (viewBox 24×24), mismo trazo del set light Trust del passenger (`trip/.../icons`).
 * `filled` la rellena con `color`; sin relleno queda el contorno visible (empty slot).
 */
function StarGlyph({size, filled, color}: StarGlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 17.8 6.7 19.2l1-5.8L3.5 9.2l5.9-.9z"
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
        fill={filled ? color : 'none'}
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', gap: 8, alignSelf: 'center'},
  star: {paddingHorizontal: 2},
});
