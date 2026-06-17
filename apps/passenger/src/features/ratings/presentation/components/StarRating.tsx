import {Text, useReducedMotion, useTheme} from '@veo/ui-kit';
import React, {useEffect} from 'react';
import {Pressable, StyleSheet, View} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

/**
 * Selector de estrellas (1-5). Usa el carácter tipográfico ★/☆ (no es emoji-icono) y acompaña el
 * estado con `accessibilityValue` para lectores de pantalla. Al tocar, la estrella da un rebote
 * sutil (resorte) y las estrellas activas se asientan con un ligero realce. Respeta reduce-motion.
 */
export function StarRating({
  value,
  onChange,
}: {
  value: number;
  onChange: (stars: number) => void;
}): React.JSX.Element {
  return (
    <View
      style={styles.row}
      accessibilityRole="adjustable"
      accessibilityValue={{min: 1, max: 5, now: value}}>
      {[1, 2, 3, 4, 5].map(star => (
        <Star
          key={star}
          star={star}
          active={star <= value}
          onPress={() => onChange(star)}
        />
      ))}
    </View>
  );
}

interface StarProps {
  star: number;
  active: boolean;
  onPress: () => void;
}

function Star({star, active, onPress}: StarProps): React.JSX.Element {
  const reduced = useReducedMotion();
  const theme = useTheme();
  const scale = useSharedValue(1);

  // Rebote al activarse (al tocar esta estrella o una superior); las inactivas vuelven a reposo.
  useEffect(() => {
    if (reduced) {
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
  }, [active, reduced, scale, theme]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{scale: scale.value}],
  }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${star}`}
      hitSlop={6}
      onPress={onPress}
      style={styles.star}>
      <Animated.View style={animatedStyle}>
        <Text variant="display" color={active ? 'warn' : 'inkSubtle'}>
          {active ? '★' : '☆'}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', gap: 8, alignSelf: 'center'},
  star: {paddingHorizontal: 2},
});
