import React from 'react';
import {StyleSheet, View} from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  interpolateColor,
  type SharedValue,
  useAnimatedStyle,
} from 'react-native-reanimated';
import {useTheme} from '@veo/ui-kit';

const DOT_SIZE = 8;
const DOT_ACTIVE_WIDTH = 26;
const DOT_GAP = 8;

interface DotProps {
  index: number;
  progress: SharedValue<number>;
  inactiveColor: string;
  activeColor: string;
}

/**
 * Punto del paginador. Interpola ancho y color según la distancia al desplazamiento actual
 * (`progress` = scrollX/pageWidth): el punto activo se expande en una píldora lima.
 */
function Dot({
  index,
  progress,
  inactiveColor,
  activeColor,
}: DotProps): React.JSX.Element {
  const theme = useTheme();
  const animatedStyle = useAnimatedStyle(() => {
    const distance = Math.abs(progress.value - index);
    return {
      width: interpolate(
        distance,
        [0, 1],
        [DOT_ACTIVE_WIDTH, DOT_SIZE],
        Extrapolation.CLAMP,
      ),
      backgroundColor: interpolateColor(
        distance,
        [0, 1],
        [activeColor, inactiveColor],
      ),
    };
  });

  return (
    <Animated.View
      style={[
        {
          height: DOT_SIZE,
          borderRadius: theme.radii.pill,
          marginHorizontal: DOT_GAP / 2,
        },
        animatedStyle,
      ]}
    />
  );
}

export interface AnimatedDotsProps {
  /** Cantidad de páginas. */
  count: number;
  /** Desplazamiento horizontal en páginas (scrollX / pageWidth). */
  progress: SharedValue<number>;
  /** Color del punto inactivo. Por defecto `border`. */
  inactiveColor?: string;
  /** Color de la píldora activa. Por defecto `accent` (lima). */
  activeColor?: string;
}

/**
 * Indicador de páginas animado: una píldora lima que se expande/contrae siguiendo el scroll
 * horizontal del carrusel (sin lógica de negocio; solo refleja la posición). a11y: oculto al
 * lector de pantalla porque la posición ya se anuncia por el contenido del slide.
 */
export function AnimatedDots({
  count,
  progress,
  inactiveColor,
  activeColor,
}: AnimatedDotsProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={styles.row}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      {Array.from({length: count}).map((_, index) => (
        <Dot
          key={index}
          index={index}
          progress={progress}
          inactiveColor={inactiveColor ?? theme.colors.border}
          activeColor={activeColor ?? theme.colors.accent}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center'},
});
