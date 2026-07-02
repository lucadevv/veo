import {Text, useReducedMotion, useTheme} from '@veo/ui-kit';
import React, {useEffect} from 'react';
import {useTranslation} from 'react-i18next';
import {Image, StyleSheet, View} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import {FadeInView} from '../../../../shared/presentation/components/motion';
import {VeoWordmark} from '../../../../shared/presentation/components/VeoWordmark';
import splashHero from '../../../../shared/assets/brand/splash-hero.jpg';

const LOADER_TRACK = 120;
const LOADER_SEGMENT = 46;

/**
 * Splash mostrado mientras se rehidrata la sesión (estado `unknown`). Sin lógica de navegación: el
 * `RootNavigator` conmuta de stack en cuanto la sesión se resuelve.
 *
 * Fidelidad al diseño (`design/veo.pen` · P/Splash): hero cinematográfico de ciudad de noche a
 * sangre + scrim en gradiente vertical (bg a 3 paradas) para legibilidad, wordmark "VEO" centrado
 * con tagline, y loader azul de marca abajo. Entrada con escala+opacidad (pantalla rara → admite
 * delight, emil); respeta reduce-motion (aparece sin transform; loader con relleno estático).
 */
export function SplashScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const reduced = useReducedMotion();

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
      withTiming(1, {
        duration: 900,
        easing: Easing.bezier(...theme.motion.easing.inOut),
      }),
      -1,
      true,
    );
  }, [reduced, sweep, theme]);

  const heroStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{scale: 0.92 + enter.value * 0.08}],
  }));

  const loaderStyle = useAnimatedStyle(() => ({
    transform: [{translateX: sweep.value * (LOADER_TRACK - LOADER_SEGMENT)}],
  }));

  return (
    <View style={[styles.container, {backgroundColor: theme.colors.bg}]}>
      <Image
        source={splashHero}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
      />
      <Svg style={StyleSheet.absoluteFill}>
        <Defs>
          <SvgLinearGradient id="splashScrim" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={theme.colors.bg} stopOpacity={0.85} />
            <Stop offset="0.42" stopColor={theme.colors.bg} stopOpacity={0.5} />
            <Stop offset="1" stopColor={theme.colors.bg} stopOpacity={0.95} />
          </SvgLinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#splashScrim)" />
      </Svg>

      <View style={styles.hero}>
        <Animated.View style={[styles.lockup, heroStyle]}>
          <VeoWordmark
            size="xl"
            color="ink"
            accessibilityLabel={t('appName')}
          />
          <FadeInView
            delay={reduced ? 0 : theme.motion.duration.slow}
            offsetY={8}>
            <Text
              variant="callout"
              color="inkMuted"
              align="center"
              style={styles.tagline}>
              {t('splashTagline')}
            </Text>
          </FadeInView>
        </Animated.View>
      </View>

      <View style={styles.loaderWrap}>
        <View
          style={[
            styles.loaderTrack,
            {
              backgroundColor: theme.colors.surfaceElevated,
              borderRadius: theme.radii.pill,
            },
          ]}>
          {reduced ? (
            <View
              style={[
                styles.loaderSegment,
                {
                  width: LOADER_SEGMENT,
                  backgroundColor: theme.colors.accent,
                  borderRadius: theme.radii.pill,
                },
              ]}
            />
          ) : (
            <Animated.View
              style={[
                styles.loaderSegment,
                {
                  width: LOADER_SEGMENT,
                  backgroundColor: theme.colors.accent,
                  borderRadius: theme.radii.pill,
                },
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
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  hero: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  lockup: {alignItems: 'center'},
  tagline: {marginTop: 14},
  loaderWrap: {position: 'absolute', bottom: 72},
  loaderTrack: {width: LOADER_TRACK, height: 4, overflow: 'hidden'},
  loaderSegment: {height: 4},
});
