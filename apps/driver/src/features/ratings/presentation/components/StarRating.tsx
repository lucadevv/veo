import React, { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useReducedMotion, useTheme } from '@veo/ui-kit';
import { IconStar } from '../../../../shared/presentation/icons';

const STARS = [1, 2, 3, 4, 5] as const;
/** Retraso de la cascada del rebote entre estrellas consecutivas (ms). */
const STAGGER_MS = 45;

export interface StarRatingProps {
  /** Estrellas seleccionadas (0 = sin elegir). */
  value: number;
  onChange: (stars: number) => void;
  /** Tamaño del ícono (px). Frame C/TripComplete = 32. */
  size?: number;
  /** Solo lectura (tras enviar la calificación): sin toque ni rebote. */
  readOnly?: boolean;
}

/**
 * Selector de estrellas 1-5 (frame C/TripComplete): activas SÓLIDAS ámbar (`warn`); inactivas en
 * OUTLINE real (trazo `inkMuted`) — calibración del dueño 2026-07-14: con strokeWidth 0 la inactiva
 * era invisible y no se notaba qué estaba elegido. Al elegir, las estrellas activas rebotan en
 * CASCADA (stagger por índice) que respeta reduce-motion. Accesible como control ajustable.
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
      accessibilityValue={{ min: 1, max: 5, now: value }}
    >
      {STARS.map((star) => (
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

function Star({ star, active, size, readOnly, onPress }: StarProps): React.JSX.Element {
  const reduced = useReducedMotion();
  const theme = useTheme();
  const scale = useSharedValue(1);

  useEffect(() => {
    if (reduced || readOnly) {
      scale.value = 1;
      return;
    }
    if (active) {
      // Cascada: cada estrella activa rebota con un retraso por índice — la selección "se enciende"
      // de izquierda a derecha en vez de saltar todo junto.
      scale.value = withDelay(
        (star - 1) * STAGGER_MS,
        withSequence(
          withSpring(1.25, theme.motion.spring.bouncy),
          withSpring(1, theme.motion.spring.default),
        ),
      );
    } else {
      scale.value = withTiming(1, { duration: theme.motion.exit.base });
    }
  }, [active, reduced, readOnly, scale, theme]);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${star}`}
      hitSlop={6}
      disabled={readOnly}
      onPress={onPress}
      style={styles.star}
    >
      <Animated.View style={animatedStyle}>
        <IconStar
          size={size}
          filled={active}
          color={active ? theme.colors.warn : theme.colors.inkMuted}
          // Activa: sólida con borde propio (canto nítido). Inactiva: OUTLINE visible — el contraste
          // que faltaba para leer qué está elegido.
          strokeWidth={2}
        />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 6, alignSelf: 'center' },
  star: { paddingHorizontal: 2 },
});
