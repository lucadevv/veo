import { Text, useReducedMotion, useTheme } from '@veo/ui-kit';
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { FadeInView } from '../../../../shared/presentation/components/motion';
import { RouteMotif } from '../../../../shared/presentation/components/RouteMotif';
import { VeoWordmark } from '../../../../shared/presentation/components/VeoWordmark';

const LOADER_TRACK = 120;
const LOADER_SEGMENT = 44;

/**
 * Splash mostrado mientras se rehidrata la sesión (estado `unknown`). Sin lógica de navegación: el
 * `RootNavigator` conmuta de stack en cuanto la sesión se resuelve. Entrada con escala+opacidad
 * (spring) del wordmark "VEO" + ruta lima punteada que se dibuja, tagline y loader lima.
 * Respeta reduce-motion (aparece sin transform; loader con relleno estático).
 */
export function SplashScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();

  const motifWidth = Math.min(width * 0.66, 280);

  const enter = useSharedValue(reduced ? 1 : 0);
  const sweep = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      enter.value = 1;
      return;
    }
    enter.value = withTiming(1, {
      duration: theme.motion.duration.slow,
      easing: Easing.bezier(...theme.motion.easing.standard),
    });
  }, [reduced, enter, theme]);

  useEffect(() => {
    if (reduced) {
      return;
    }
    sweep.value = withRepeat(
      withTiming(1, { duration: 900, easing: Easing.bezier(...theme.motion.easing.inOut) }),
      -1,
      true,
    );
  }, [reduced, sweep, theme]);

  const heroStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{ scale: 0.92 + enter.value * 0.08 }],
  }));

  const loaderStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: sweep.value * (LOADER_TRACK - LOADER_SEGMENT) }],
  }));

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.bg }]}>
      <View style={styles.hero}>
        <Animated.View style={[styles.heroGroup, heroStyle]}>
          <VeoWordmark size="xl" color="ink" />
          <RouteMotif width={motifWidth} height={64} animated style={styles.motif} />
        </Animated.View>

        <FadeInView delay={reduced ? 0 : theme.motion.duration.slow} offsetY={8}>
          <Text variant="callout" color="inkMuted" align="center" style={styles.tagline}>
            {t('splashTagline')}
          </Text>
        </FadeInView>
      </View>

      <View style={styles.loaderWrap}>
        <View
          style={[
            styles.loaderTrack,
            { backgroundColor: theme.colors.surfaceElevated, borderRadius: theme.radii.pill },
          ]}
        >
          {reduced ? (
            <View
              style={[
                styles.loaderSegment,
                { width: LOADER_SEGMENT, backgroundColor: theme.colors.accent, borderRadius: theme.radii.pill },
              ]}
            />
          ) : (
            <Animated.View
              style={[
                styles.loaderSegment,
                { width: LOADER_SEGMENT, backgroundColor: theme.colors.accent, borderRadius: theme.radii.pill },
                loaderStyle,
              ]}
            />
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  hero: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  heroGroup: { alignItems: 'center' },
  motif: { marginTop: -18 },
  tagline: { marginTop: 8 },
  loaderWrap: { position: 'absolute', bottom: 64 },
  loaderTrack: { width: LOADER_TRACK, height: 5, overflow: 'hidden' },
  loaderSegment: { height: 5 },
});
