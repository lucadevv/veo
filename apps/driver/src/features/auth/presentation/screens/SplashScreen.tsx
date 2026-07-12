import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';
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
import { VeoEmblem } from '../../../../shared/presentation/components/VeoEmblem';

/**
 * Splash de arranque del conductor (drv-01), fiel al pen `C/Splash` (board CONDUCTOR, Theme de
 * Confianza light): lienzo con gradiente claro vertical, un emblema teal (squircle + auto) sobre un
 * glow radial teal, el lockup "VEO / CONDUCTORES" con acento de marca, el tagline "Maneja. Gana.
 * Protegido." y una barra de progreso. Se muestra durante el estado `bootstrapping` del RootNavigator.
 * Respeta reduce-motion: degrada a un crossfade sin escalado.
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

  const lockupStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: reduced ? [] : [{ scale: 0.92 + enter.value * 0.08 }],
  }));

  const taglineStyle = useAnimatedStyle(() => ({ opacity: enter.value }));

  const progressStyle = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));

  return (
    <View style={styles.root}>
      {/* Lienzo: gradiente vertical claro (surface #FFFFFF → bg) + glow radial teal detrás del emblema. */}
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" pointerEvents="none">
        <Defs>
          <LinearGradient id="splashBg" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={theme.colors.surface} />
            <Stop offset="1" stopColor={theme.colors.bg} />
          </LinearGradient>
          <RadialGradient id="splashGlow" cx="50%" cy="44%" r="40%">
            <Stop offset="0" stopColor={theme.colors.brand} stopOpacity={0.15} />
            <Stop offset="1" stopColor={theme.colors.brand} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width="100%" height="100%" fill="url(#splashBg)" />
        <Rect x={0} y={0} width="100%" height="100%" fill="url(#splashGlow)" />
      </Svg>

      <View style={styles.center}>
        <Animated.View style={[styles.lockup, lockupStyle]}>
          <VeoEmblem size={100} />
          <Text
            variant="display"
            color="ink"
            align="center"
            style={styles.veo}
          >
            VEO
          </Text>
          <Text variant="caption" color="inkMuted" align="center" style={styles.sub}>
            CONDUCTORES
          </Text>
          <View style={[styles.accent, { backgroundColor: theme.colors.brand }]} accessible={false} />
        </Animated.View>
      </View>

      <Animated.View style={[styles.taglineWrap, taglineStyle]}>
        <Text variant="callout" color="inkMuted" align="center" style={styles.tagline}>
          {t('auth.tagline')}
        </Text>
      </Animated.View>

      <View style={styles.progressWrap}>
        <View style={[styles.progressTrack, { backgroundColor: theme.colors.skeleton }]}>
          <Animated.View
            style={[styles.progressFill, { backgroundColor: theme.colors.brand }, progressStyle]}
          />
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center' },
  // BrandLockup del pen: vertical, gap 16 uniforme entre emblema, VEO, CONDUCTORES y el acento.
  lockup: { alignItems: 'center', gap: 16 },
  veo: { fontSize: 64, lineHeight: 68, letterSpacing: 2 },
  sub: { fontSize: 13, letterSpacing: 6 },
  accent: { width: 28, height: 4, borderRadius: 999 },
  taglineWrap: { position: 'absolute', bottom: 132, left: 0, right: 0, alignItems: 'center' },
  tagline: { letterSpacing: 0.5 },
  progressWrap: { position: 'absolute', bottom: 56, alignItems: 'center', width: '100%' },
  progressTrack: { width: 72, height: 4, borderRadius: 999, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 999 },
});
