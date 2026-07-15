import React, { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
} from 'react-native-reanimated';
import { useTheme } from '../theme/ThemeProvider';
import { useReducedMotion } from '../theme/useReducedMotion';

/**
 * Verde JADE del sello, FIJO cross-app (excepción documentada): el token `success` diverge por app
 * (passenger jade #17C08A, driver #00C853) → usar `theme.colors.success` rompería la SIMETRÍA del momento
 * de éxito. El jade es el de la referencia (TripComplete del conductor, que ya lo hardcodeaba). El check va
 * en `onSuccess` (#04160D en los 3 themes → simétrico) vía el theme.
 */
const SUCCESS_JADE = '#17C08A';

export interface SuccessCheckProps {
  /** Diámetro del círculo. Default 72 (hero). Usá ~40 para inline. */
  size?: number;
  /** Anima la entrada (pop resorte + fade). Default true; respeta reduce-motion (estado final inmediato). */
  animate?: boolean;
}

const AnimatedSvg = Animated.createAnimatedComponent(Svg);

/**
 * Sello de ÉXITO canónico (passenger + driver): círculo VERDE SÓLIDO (`success`) con un check SVG en
 * `onSuccess` (verde casi-negro #04160D → lee como "check negro" sobre el verde) que entra con RESORTE
 * (scale 0.6→1 + fade). Un solo momento de éxito idéntico en toda la app — antes había 3 defs duplicadas
 * (círculo + ✓ tipográfico) en el pasajero y un badge translúcido distinto en el conductor.
 *
 * Confirma una acción/cierre puntual (viaje completado, pago/propina, deuda saldada, verificación, etc.).
 * Presentacional; el título/subtítulo los compone la pantalla alrededor. Respeta reduce-motion. Cero hex
 * inline: todo del theme.
 */
export function SuccessCheck({ size = 72, animate = true }: SuccessCheckProps): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const progress = useSharedValue(animate && !reduced ? 0 : 1);

  useEffect(() => {
    if (!animate || reduced) {
      progress.value = 1;
      return;
    }
    progress.value = withDelay(60, withSpring(1, theme.motion.spring.bouncy));
  }, [animate, reduced, progress, theme]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.6 + progress.value * 0.4 }],
  }));

  // Check ~50% del diámetro, centrado en el círculo.
  const checkSize = Math.round(size * 0.5);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.circle,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: SUCCESS_JADE,
        },
        animatedStyle,
      ]}
    >
      <AnimatedSvg width={checkSize} height={checkSize} viewBox="0 0 24 24" fill="none">
        <Polyline
          points="4,12 10,18 20,6"
          stroke={theme.colors.onSuccess}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </AnimatedSvg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
});
