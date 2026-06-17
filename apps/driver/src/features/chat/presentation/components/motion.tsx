import React, { type ReactNode } from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, FadeIn, FadeInDown } from 'react-native-reanimated';
import { useReducedMotion, useTheme } from '@veo/ui-kit';

export interface BubbleAppearProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * Entrada de burbuja de chat: fade-up corto (translateY + opacidad, ease-out). Degrada a fade puro
 * con reduce-motion. Duración base (~200ms) para que cada mensaje aparezca con vida sin demorar.
 */
export function BubbleAppear({ children, style }: BubbleAppearProps): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const { duration, easing } = theme.motion;
  const entering = reduced
    ? FadeIn.duration(duration.fast)
    : FadeInDown.duration(duration.base)
        .easing(Easing.bezierFn(...easing.standard))
        .withInitialValues({ opacity: 0, transform: [{ translateY: 8 }] });
  return (
    <Animated.View entering={entering} style={style}>
      {children}
    </Animated.View>
  );
}
