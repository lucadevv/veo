import React, { useEffect } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useReducedMotion } from '@veo/ui-kit';

interface WizardPagerProps {
  /** Página activa (0-based). El carril se traslada a `-index * ancho` con una transición animada. */
  index: number;
  /** Las páginas, en orden. Viven SIEMPRE montadas: el estado de cada paso se preserva entre cambios. */
  children: React.ReactNode;
}

/**
 * Pager horizontal INDEX-DRIVEN del wizard de registro (estilo `PageView` de Flutter, pero gobernado por
 * índice, no por swipe libre): el avance/retroceso lo dispara el footer (Continuar/Atrás), así el gating de
 * cada paso se RESPETA (no se puede saltar adelante sin completar). Las páginas se mantienen montadas (no se
 * pierde el progreso ni el scroll de cada paso); solo se traslada el carril con una transición Reanimated.
 *
 * a11y: respeta "reducir movimiento" — sin animación, salto directo a la página (nada de movimiento gratis).
 */
export function WizardPager({ index, children }: WizardPagerProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const reduced = useReducedMotion();
  const pages = React.Children.toArray(children);
  const translateX = useSharedValue(-index * width);

  useEffect(() => {
    const target = -index * width;
    translateX.value = reduced
      ? target
      : withTiming(target, { duration: 340, easing: Easing.bezier(0.22, 1, 0.36, 1) });
  }, [index, width, reduced, translateX]);

  const railStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));

  return (
    <View style={styles.viewport}>
      <Animated.View style={[styles.rail, { width: width * pages.length }, railStyle]}>
        {pages.map((page, i) => (
          <View key={i} style={{ width }}>
            {page}
          </View>
        ))}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  viewport: { flex: 1, overflow: 'hidden' },
  rail: { flex: 1, flexDirection: 'row' },
});
