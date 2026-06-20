import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useTheme, useReducedMotion } from '@veo/ui-kit';
import { useTranslation } from 'react-i18next';
import { REGISTRATION_TOTAL_STEPS } from '../state/registrationStore';

interface RegistrationProgressProps {
  /** Paso actual (1..total). */
  current: number;
  total?: number;
}

/** Un segmento de la barra: pista oscura con relleno cian que crece de izquierda a derecha. */
function Segment({ filled, index }: { filled: boolean; index: number }): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const fill = useSharedValue(filled ? 1 : 0);

  useEffect(() => {
    const target = filled ? 1 : 0;
    if (reduced) {
      fill.value = withTiming(target, { duration: theme.motion.duration.base });
      return;
    }
    // Escalonado sutil por índice para que el avance "barra" se lea como progreso, no como flash.
    fill.value = withDelay(
      index * 60,
      withTiming(target, {
        duration: theme.motion.duration.slow,
        easing: Easing.bezier(...theme.motion.easing.standard),
      }),
    );
  }, [filled, fill, index, reduced, theme]);

  const fillStyle = useAnimatedStyle(() => ({
    width: `${fill.value * 100}%`,
  }));

  return (
    <View
      style={[
        styles.track,
        { backgroundColor: theme.colors.surfaceElevated, borderRadius: theme.radii.pill },
      ]}
    >
      <Animated.View
        style={[
          styles.fill,
          { backgroundColor: theme.colors.accent, borderRadius: theme.radii.pill },
          fillStyle,
        ]}
      />
    </View>
  );
}

/**
 * Barra de progreso del wizard: un segmento redondeado por paso (la cantidad se DERIVA de
 * `REGISTRATION_TOTAL_STEPS`, sin número mágico). Los pasos alcanzados se rellenan en cian
 * con una animación de crecimiento (ease-out, <320ms) escalonada; respeta reduce-motion. Es un
 * indicador puramente visual con etiqueta accesible del progreso global.
 */
export function RegistrationProgress({
  current,
  total = REGISTRATION_TOTAL_STEPS,
}: RegistrationProgressProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={t('registration.progressLabel', { current, total })}
      accessibilityValue={{ min: 1, max: total, now: current }}
      style={[styles.row, { gap: theme.spacing.sm }]}
    >
      {Array.from({ length: total }).map((_, index) => (
        <Segment key={index} index={index} filled={index < current} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignSelf: 'stretch' },
  track: { flex: 1, height: 5, overflow: 'hidden' },
  fill: { height: '100%' },
});
