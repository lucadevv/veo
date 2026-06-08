import React, { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
} from 'react-native-reanimated';
import { Text, useReducedMotion, useTheme } from '@veo/ui-kit';

export interface SuccessCheckProps {
  size?: number;
}

/**
 * Sello de éxito: círculo `success` con check tipográfico que entra con resorte (scale 0.6→1 + fade).
 * Confirma el envío de la calificación. Respeta reduce-motion (estado final inmediato).
 */
export function SuccessCheck({ size = 72 }: SuccessCheckProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      progress.value = 1;
      return;
    }
    progress.value = withDelay(60, withSpring(1, theme.motion.spring.bouncy));
  }, [reduced, progress, theme]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.6 + progress.value * 0.4 }],
  }));

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.check,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: theme.colors.success },
        animatedStyle,
      ]}
    >
      <Text variant="title1" color="onSuccess">
        ✓
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  check: { alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
});
