import React, {type ReactNode} from 'react';
import {type StyleProp, type ViewStyle} from 'react-native';
import Animated, {Easing, FadeIn, FadeInDown} from 'react-native-reanimated';
import {useReducedMotion, useTheme} from '@veo/ui-kit';

export interface AppearProps {
  children: ReactNode;
  /** Retardo de entrada (ms) para escalonar (stagger). */
  delay?: number;
  /** Desplazamiento vertical inicial (px). */
  distance?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Entrada fade + translateY con ease-out (tokens `theme.motion`). Degrada a fade puro con
 * reduce-motion (sin movimiento de posición). Solo anima transform/opacity (GPU).
 */
export function Appear({children, delay = 0, distance = 10, style}: AppearProps): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const {duration, easing} = theme.motion;
  const entering = reduced
    ? FadeIn.duration(duration.base).delay(delay)
    : FadeInDown.duration(duration.slow)
        .delay(delay)
        .easing(Easing.bezierFn(...easing.standard))
        .withInitialValues({opacity: 0, transform: [{translateY: distance}]});
  return (
    <Animated.View entering={entering} style={style}>
      {children}
    </Animated.View>
  );
}
