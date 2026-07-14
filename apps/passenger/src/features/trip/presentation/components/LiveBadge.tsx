import {fontFamily, Text, useReducedMotion, useTheme} from '@veo/ui-kit';
import React, {useEffect} from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {IconVideo} from './icons';
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
 * Pill "EN VIVO" sobre el mapa del viaje activo — FIEL al frame `RecPill` del design/veo.pen (ed6D3):
 * card BLANCA (`surface`) con borde `border` 1px y radio pill, dot 8 + glifo de VIDEO 15 (lucide
 * `video`) ambos en `danger`, label "EN VIVO" Outfit SemiBold 12 en `ink`, gap 7 y padding 13×9.
 * La sombra del frame (0/4/12/-4) se rinde con el token `level2` del DS (RN `shadow*` no soporta
 * spread; equivalencia documentada). El punto PULSA suave (~2s, opacidad + halo en escala) en el UI
 * thread (reanimated, sin timers JS) — decorativo, el frame es estático.
 *
 * COLOR — deliberado, NO tocar a verde: dot y videocámara son `danger` (ROJO) porque su semántica es
 * REC/grabación (la cámara del habitáculo transmite), el código universal de "estás siendo grabado".
 * Cambiarlo a `success` rompería la señal de seguridad. Cero hex inline: todo sale del theme.
 *
 * Accesibilidad: expone el label como texto ("EN VIVO"); dot e ícono son decorativos. Respeta
 * reduce-motion.
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
          backgroundColor: theme.colors.surface,
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
      {/* Videocámara ROJA 15 (pen ed6D3 `Cam`, lucide video): dice QUÉ está en vivo — el video del
          habitáculo. Decorativa (el label habla). */}
      <View
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden>
        <IconVideo color={theme.colors.danger} size={15} />
      </View>
      {/* Label del frame: Outfit SemiBold 12 (el rol `caption` con la cara semibold — el frame pide
          Outfit 600, no la Clash del rol `label`). */}
      <Text variant="caption" color="ink" style={styles.label}>
        {t('trip.live')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Números EXACTOS del frame RecPill (ed6D3): gap 7, padding [9,13], stroke 1.
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 7,
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderWidth: 1,
  },
  label: {fontFamily: fontFamily.textSemibold, fontWeight: '600'},
  dotWrap: {
    width: 8,
    height: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {width: 8, height: 8},
  halo: {position: 'absolute', width: 8, height: 8},
});
