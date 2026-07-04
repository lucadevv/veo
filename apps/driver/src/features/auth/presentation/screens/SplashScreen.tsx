import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  withSpring,
} from 'react-native-reanimated';
import { Text, useTheme, useReducedMotion } from '@veo/ui-kit';
import { VeoWordmark } from '../../../../shared/presentation/components/VeoWordmark';

/**
 * Splash de arranque del conductor (drv-01), a imagen del pen `C/Splash` (board CONDUCTOR): composición
 * LIMPIA sin motivo de ruta — un glow radial azul detrás del wordmark "VEO Conductores", un acento de
 * marca (pill cian) bajo el lockup, el tagline "Maneja. Gana. Protegido." y la barra de progreso.
 * Se muestra durante el estado `bootstrapping` del RootNavigator. Respeta reduce-motion: degrada a un
 * crossfade sin escalado.
 */
export const SplashScreen = (): React.JSX.Element => {
  const theme = useTheme();
  const { t } = useTranslation();
  const reduced = useReducedMotion();

  const enter = useSharedValue(0);
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      enter.value = withTiming(1, { duration: theme.motion.duration.base });
      progress.value = withTiming(1, { duration: theme.motion.duration.slow });
      return;
    }
    enter.value = withSpring(1, theme.motion.spring.default);
    progress.value = withDelay(
      200,
      withTiming(1, { duration: 1100, easing: Easing.bezier(...theme.motion.easing.standard) }),
    );
  }, [enter, progress, reduced, theme]);

  const wordmarkStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: reduced ? [] : [{ scale: 0.92 + enter.value * 0.08 }],
  }));

  const taglineStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
  }));

  const progressStyle = useAnimatedStyle(() => ({
    width: `${progress.value * 100}%`,
  }));

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.bg }]}>
      {/* Glow radial azul detrás del wordmark (decorativo, muy sutil). */}
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" pointerEvents="none">
        <Defs>
          <RadialGradient id="splashGlow" cx="50%" cy="46%" r="42%">
            <Stop offset="0" stopColor={theme.colors.accent} stopOpacity={0.16} />
            <Stop offset="1" stopColor={theme.colors.accent} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width="100%" height="100%" fill="url(#splashGlow)" />
      </Svg>

      <View style={styles.center}>
        <Animated.View style={[styles.wordmark, wordmarkStyle]}>
          {/* Wordmark del splash como el pen: "VEO" blanco (ink), "CONDUCTORES" gris sutil (inkSubtle). */}
          <VeoWordmark size="xl" veoColor="ink" subColor="inkSubtle" />
          {/* Acento de marca bajo el lockup: mismo lenguaje visual que la barra de progreso. */}
          <View
            style={[styles.brandAccent, { backgroundColor: theme.colors.accent }]}
            accessible={false}
          />
        </Animated.View>
      </View>

      <Animated.View style={[styles.taglineWrap, taglineStyle]}>
        <Text variant="callout" color="inkMuted" align="center">
          {t('auth.tagline')}
        </Text>
      </Animated.View>

      <View style={styles.progressWrap}>
        <View style={[styles.progressTrack, { backgroundColor: theme.colors.surfaceElevated }]}>
          <Animated.View
            style={[styles.progressFill, { backgroundColor: theme.colors.accent }, progressStyle]}
          />
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center' },
  wordmark: { alignItems: 'center' },
  brandAccent: { width: 28, height: 4, borderRadius: 2, marginTop: 12 },
  taglineWrap: { position: 'absolute', bottom: 120, left: 0, right: 0, alignItems: 'center' },
  progressWrap: { position: 'absolute', bottom: 56, alignItems: 'center', width: '100%' },
  progressTrack: { width: 72, height: 4, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 2 },
});
