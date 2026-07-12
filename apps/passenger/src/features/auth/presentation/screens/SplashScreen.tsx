import {Text, useReducedMotion, useTheme} from '@veo/ui-kit';
import React, {useEffect} from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, {
  Defs,
  LinearGradient,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import {FadeInView} from '../../../../shared/presentation/components/motion';
import {VeoWordmark} from '../../../../shared/presentation/components/VeoWordmark';
import {IconEye} from '../components/icons';

const LOADER_TRACK = 120;
const LOADER_SEGMENT = 46;
// Emblema teal 100×100 (design/veo.pen · P/Splash · `mJQ1v`), eye 52 centrado (padding 24).
const ICON = 100;
const EYE = 52;
// Halo radial de marca detrás del lockup (300×300, `nFcJb`): teal a transparente, muy suave.
const GLOW = 300;

/**
 * Splash mostrado mientras se rehidrata la sesión (estado `unknown`). Sin lógica de navegación: el
 * `RootNavigator` conmuta de stack en cuanto la sesión se resuelve.
 *
 * Fidelidad al diseño (`design/veo.pen` · P/Splash · Theme de Confianza): lienzo claro, icono de
 * marca (ojo) en cuadro teal con halo suave, wordmark "VEO" centrado con tagline, y loader teal
 * abajo. Entrada con escala+opacidad (pantalla rara → admite delight, emil); respeta reduce-motion
 * (aparece sin transform; loader con relleno estático).
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

  const lockupStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{scale: 0.92 + enter.value * 0.08}],
  }));

  const loaderStyle = useAnimatedStyle(() => ({
    transform: [{translateX: sweep.value * (LOADER_TRACK - LOADER_SEGMENT)}],
  }));

  return (
    <View style={[styles.container, {backgroundColor: theme.colors.bg}]}>
      <View style={styles.hero}>
        <Animated.View style={[styles.lockup, lockupStyle]}>
          {/* Halo radial de marca detrás del lockup (`nFcJb`): teal 15% → transparente. */}
          <Svg
            width={GLOW}
            height={GLOW}
            style={styles.glow}
            pointerEvents="none">
            <Defs>
              <RadialGradient id="splashGlow" cx="50%" cy="50%" r="50%">
                <Stop
                  offset="0"
                  stopColor={theme.colors.accent}
                  stopOpacity={0.15}
                />
                <Stop
                  offset="1"
                  stopColor={theme.colors.accent}
                  stopOpacity={0}
                />
              </RadialGradient>
            </Defs>
            <Rect width={GLOW} height={GLOW} fill="url(#splashGlow)" />
          </Svg>
          <View
            style={[
              styles.iconBadge,
              {
                backgroundColor: theme.colors.brandHover,
                borderRadius: theme.radii.xl,
                shadowColor: theme.colors.accent,
              },
            ]}>
            {/* Relleno degradado teal (brand → brandHover, 135°) fiel al emblema del .pen. */}
            <Svg
              width={ICON}
              height={ICON}
              style={StyleSheet.absoluteFill}
              pointerEvents="none">
              <Defs>
                <LinearGradient id="splashBadge" x1="0" y1="0" x2="1" y2="1">
                  <Stop offset="0" stopColor={theme.colors.brand} />
                  <Stop offset="1" stopColor={theme.colors.brandHover} />
                </LinearGradient>
              </Defs>
              <Rect
                width={ICON}
                height={ICON}
                rx={theme.radii.xl}
                fill="url(#splashBadge)"
              />
            </Svg>
            <IconEye color={theme.colors.onAccent} size={EYE} />
          </View>
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
              backgroundColor: theme.colors.border,
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
  glow: {position: 'absolute', top: -100},
  iconBadge: {
    width: ICON,
    height: ICON,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    shadowOffset: {width: 0, height: 14},
    shadowOpacity: 0.3,
    shadowRadius: 24,
    elevation: 12,
  },
  tagline: {marginTop: 16, letterSpacing: 1},
  loaderWrap: {position: 'absolute', bottom: 72},
  loaderTrack: {width: LOADER_TRACK, height: 4, overflow: 'hidden'},
  loaderSegment: {height: 4},
});
