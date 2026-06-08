import React from 'react';
import {StyleSheet, View} from 'react-native';
import Svg, {Circle} from 'react-native-svg';
import {Text, useTheme} from '@veo/ui-kit';

export interface CountdownRingProps {
  /** Segundos restantes a mostrar al centro del anillo. */
  seconds: number;
  /** Fracción de tiempo restante (0..1). Lo calcula la pantalla con el countdown real. */
  progress: number;
  /** Diámetro del anillo en px. */
  size?: number;
  /** Grosor del trazo del anillo. */
  strokeWidth?: number;
  /** Estado vencido: tiñe el progreso/cifra en `danger`. */
  expired?: boolean;
}

/**
 * Anillo de cuenta regresiva "Midnight Motion" (cian) dibujado con react-native-svg: un círculo de
 * fondo (borderStrong) y un círculo de progreso (accent) cuyo `strokeDashoffset` refleja el % real
 * de tiempo restante del countdown. La cifra de segundos va al centro. No anima por sí mismo: el
 * valor cambia cada segundo desde el `useCountdown` existente.
 */
export function CountdownRing({
  seconds,
  progress,
  size = 104,
  strokeWidth = 8,
  expired = false,
}: CountdownRingProps): React.JSX.Element {
  const theme = useTheme();
  const clamped = Math.min(1, Math.max(0, progress));
  const center = size / 2;
  const radius = center - strokeWidth / 2;
  const circumference = 2 * Math.PI * radius;
  // Trazado del arco restante: offset proporcional al tiempo ya consumido.
  const dashOffset = circumference * (1 - clamped);
  const progressColor = expired ? theme.colors.danger : theme.colors.accent;

  return (
    <View style={[styles.wrap, {width: size, height: size}]}>
      <Svg width={size} height={size} style={styles.svg}>
        <Circle
          cx={center}
          cy={center}
          r={radius}
          stroke={theme.colors.borderStrong}
          strokeWidth={strokeWidth}
          fill="none"
        />
        <Circle
          cx={center}
          cy={center}
          r={radius}
          stroke={progressColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          fill="none"
        />
      </Svg>
      <View style={styles.center} pointerEvents="none">
        <Text variant="title1" color={expired ? 'danger' : 'ink'} tabular>
          {seconds}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {alignItems: 'center', justifyContent: 'center'},
  // El SVG arranca a las 3:00; lo rotamos -90° para que el arco comience arriba (12:00).
  svg: {transform: [{rotate: '-90deg'}]},
  center: {...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center'},
});
