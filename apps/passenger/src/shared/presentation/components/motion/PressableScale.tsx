import React, {useCallback} from 'react';
import {
  Pressable,
  type PressableProps,
  StyleSheet,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {useReducedMotion, useTheme} from '@veo/ui-kit';

export interface PressableScaleProps extends Omit<PressableProps, 'style'> {
  children: React.ReactNode;
  /** Escala objetivo al presionar (0.95–0.98). Por defecto `motion.scale.press` (0.97). */
  scaleTo?: number;
  style?: ViewStyle | ViewStyle[];
  contentStyle?: ViewStyle | ViewStyle[];
}

/**
 * Envoltorio presionable con feedback de escala (interrumpible, ease-out). Respeta reduce-motion.
 * Para cualquier elemento tappable que no sea un `Button`/`Card` del ui-kit (FABs, filas, chips).
 */
export function PressableScale({
  children,
  scaleTo,
  style,
  contentStyle,
  disabled,
  onPressIn,
  onPressOut,
  hitSlop = 8,
  ...rest
}: PressableScaleProps): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const scale = useSharedValue(1);
  const target = scaleTo ?? theme.motion.scale.press;

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{scale: scale.value}],
  }));

  const handlePressIn = useCallback<NonNullable<PressableProps['onPressIn']>>(
    event => {
      if (!reduced && !disabled) {
        scale.value = withTiming(target, {
          duration: theme.motion.duration.fast,
          easing: Easing.bezier(...theme.motion.easing.standard),
        });
      }
      onPressIn?.(event);
    },
    [reduced, disabled, target, theme, scale, onPressIn],
  );

  const handlePressOut = useCallback<NonNullable<PressableProps['onPressOut']>>(
    event => {
      if (!reduced && !disabled) {
        scale.value = withTiming(1, {
          duration: theme.motion.exit.base,
          easing: Easing.bezier(...theme.motion.easing.standard),
        });
      }
      onPressOut?.(event);
    },
    [reduced, disabled, theme, scale, onPressOut],
  );

  return (
    <Pressable
      disabled={disabled}
      hitSlop={hitSlop}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={style as ViewStyle}
      {...rest}>
      <Animated.View style={[styles.content, animatedStyle, contentStyle]}>
        {children}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {alignSelf: 'stretch'},
});
