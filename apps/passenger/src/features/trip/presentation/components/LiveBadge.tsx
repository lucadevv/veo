import {Text, useReducedMotion, useTheme} from '@veo/ui-kit';
import React, {useEffect} from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {IconCamera} from './icons';
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

/**
 * Pill "EN VIVO" sobre el mapa del viaje activo. Pieza PREMIUM dedicada (no el StatusPill genérico): es
 * la señal del diferenciador de seguridad de VEO ("tu viaje se transmite en vivo"), así que merece su
 * propio tratamiento — fondo GLASS oscuro del DS (`overlay`), borde sutil, tipografía chica en
 * VERSALITAS con tracking (variante `label`) y un punto VERDE (token `success`) que PULSA suave (~2s,
 * opacidad + halo en escala) en el UI thread (reanimated, sin timers JS → pausa solo en background).
 *
 * Por qué dedicada y no el StatusPill: el StatusPill se reusa para muchos estados (su fondo es un tinte
 * del tono); para el overlay del mapa queríamos un cristal oscuro legible sobre cualquier punto del mapa
 * y un dot vivo, sin mutar el componente compartido. Color verde = token `success` (cero hex inline).
 *
 * Accesibilidad: expone el label como texto ("EN VIVO"); el pulso es decorativo. Respeta reduce-motion.
 */
export function LiveBadge(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const reduced = useReducedMotion();

  // Pulso del punto: 0→1→0 en loop (~2s total). Maneja opacidad del dot y el halo (escala + fade).
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (reduced) {
      cancelAnimation(pulse);
      pulse.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, {duration: 1_000, easing: Easing.inOut(Easing.quad)}),
        withTiming(0, {duration: 1_000, easing: Easing.inOut(Easing.quad)}),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(pulse);
  }, [reduced, pulse]);

  // El dot baja apenas su opacidad en el valle del pulso (sigue presente, nunca parpadea a 0).
  const dotStyle = useAnimatedStyle(() => ({
    opacity: interpolate(pulse.value, [0, 1], [0.55, 1]),
  }));
  // El halo crece y se desvanece (anillo de "señal viva" alrededor del dot).
  const haloStyle = useAnimatedStyle(() => ({
    opacity: interpolate(pulse.value, [0, 1], [0.4, 0]),
    transform: [{scale: interpolate(pulse.value, [0, 1], [1, 2.4])}],
  }));

  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={t('trip.live')}
      style={[
        styles.pill,
        {
          backgroundColor: theme.colors.overlay,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.pill,
          ...theme.elevation.level2,
        },
      ]}>
      <View
        style={styles.dotWrap}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden>
        <Animated.View
          style={[
            styles.halo,
            {backgroundColor: theme.colors.danger, borderRadius: 999},
            haloStyle,
          ]}
        />
        <Animated.View
          style={[
            styles.dot,
            {backgroundColor: theme.colors.danger, borderRadius: 999},
            dotStyle,
          ]}
        />
      </View>
      {/* Glifo de cámara (design/veo.pen fLKdk RecPill): la pill dice QUÉ está en vivo — el video del
          habitáculo. El punto pasa a `danger` (semántica REC), no `success`. Decorativo (el label habla). */}
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <IconCamera color={theme.colors.ink} size={12} />
      </View>
      <Text variant="label" color="ink">
        {t('trip.live')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dotWrap: {
    width: 8,
    height: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {width: 8, height: 8},
  halo: {position: 'absolute', width: 8, height: 8},
});
