import {useReducedMotion, useTheme} from '@veo/ui-kit';
import React, {useEffect} from 'react';
import {StyleSheet} from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {SplashScreen} from '../../features/auth/presentation';
import {
  DEFAULT_MIN_SPLASH_MS,
  useMinimumSplash,
} from '../hooks/useMinimumSplash';

export interface SplashGateProps {
  /** `true` cuando la sesión (y demás gates aguas arriba) ya se resolvió y se puede revelar el stack. */
  ready: boolean;
  /** Se invoca UNA vez, tras el fade-out, cuando el splash terminó de salir con gusto. */
  onDone: () => void;
  /** Piso de duración (ms). Override para tests; por defecto el de marca (~1.9s). */
  minMs?: number;
}

/**
 * Envuelve el `SplashScreen` de marca con dos garantías de gusto:
 *  1. PISO de duración: aunque `ready` sea `true` al instante (rehidratación MMKV), el splash
 *     permanece hasta cumplir el mínimo (`useMinimumSplash`). Es un piso, no un techo: si la
 *     sesión tarda, `ready` llega tarde y el splash sigue (lo correcto).
 *  2. SALIDA con fade-out: cuando `ready && !floor`, desvanece el contenedor (no corte seco) y
 *     recién ahí llama `onDone` para que el `RootNavigator` revele el stack real.
 *
 * Respeta reduce-motion: sin piso animado y salida instantánea (sin fade).
 */
export function SplashGate({
  ready,
  onDone,
  minMs,
}: SplashGateProps): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  // En reduce-motion el piso se degrada a 0 (sin demora artificial ni animación).
  const floorPending = useMinimumSplash(
    reduced ? 0 : (minMs ?? DEFAULT_MIN_SPLASH_MS),
  );

  const opacity = useSharedValue(1);
  const reveal = ready && !floorPending;

  useEffect(() => {
    if (!reveal) {
      return;
    }
    if (reduced) {
      onDone();
      return;
    }
    opacity.value = withTiming(
      0,
      {
        duration: theme.motion.exit.slow,
        easing: Easing.bezier(...theme.motion.easing.standard),
      },
      finished => {
        if (finished) {
          runOnJS(onDone)();
        }
      },
    );
    // `onDone`/`theme` estables durante la vida del gate; el efecto depende del cruce de `reveal`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  const fadeStyle = useAnimatedStyle(() => ({opacity: opacity.value}));

  return (
    <Animated.View
      style={[styles.fill, {backgroundColor: theme.colors.bg}, fadeStyle]}
      pointerEvents="none">
      <SplashScreen />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: {flex: 1},
});
