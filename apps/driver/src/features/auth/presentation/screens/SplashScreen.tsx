import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  withSpring,
} from 'react-native-reanimated';
import { Text, useTheme, useReducedMotion } from '@veo/ui-kit';
import { VeoWordmark } from '../../../../shared/presentation/components/VeoWordmark';

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** Longitud aproximada del trazo de la ruta (para el dibujo progresivo con dashoffset). */
const ROUTE_LENGTH = 620;

/**
 * Splash de arranque del conductor (drv-01). Revela el wordmark "VEO Conductores" con una entrada
 * de escala + opacidad (spring) sobre una ruta cian con glow que se "dibuja" sola, y el tagline
 * "Maneja. Gana. Protegido.". Se muestra durante el estado `bootstrapping` del RootNavigator.
 * Respeta reduce-motion: degrada a un crossfade sin dibujo ni escalado.
 */
export const SplashScreen = (): React.JSX.Element => {
  const theme = useTheme();
  const { t } = useTranslation();
  const reduced = useReducedMotion();

  const enter = useSharedValue(0);
  const draw = useSharedValue(reduced ? 1 : 0);
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      enter.value = withTiming(1, { duration: theme.motion.duration.base });
      progress.value = withTiming(1, { duration: theme.motion.duration.slow });
      return;
    }
    enter.value = withSpring(1, theme.motion.spring.default);
    draw.value = withDelay(
      120,
      withTiming(1, { duration: 900, easing: Easing.bezier(...theme.motion.easing.inOut) }),
    );
    progress.value = withDelay(
      200,
      withTiming(1, { duration: 1100, easing: Easing.bezier(...theme.motion.easing.standard) }),
    );
  }, [draw, enter, progress, reduced, theme]);

  const wordmarkStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: reduced ? [] : [{ scale: 0.92 + enter.value * 0.08 }],
  }));

  const taglineStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
  }));

  const routeProps = useAnimatedProps(() => ({
    strokeDashoffset: ROUTE_LENGTH * (1 - draw.value),
  }));

  const progressStyle = useAnimatedStyle(() => ({
    width: `${progress.value * 100}%`,
  }));

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.bg }]}>
      {/* Ruta cian con glow que cruza el lienzo (decorativa). */}
      <Svg
        style={StyleSheet.absoluteFill}
        width="100%"
        height="100%"
        viewBox="0 0 390 760"
        pointerEvents="none"
      >
        <AnimatedPath
          d="M120 700 C 150 560, 60 470, 150 400 S 320 320, 250 210 S 210 90, 300 70"
          stroke={theme.colors.accent}
          strokeOpacity={0.22}
          strokeWidth={14}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={ROUTE_LENGTH}
          animatedProps={routeProps}
        />
        <AnimatedPath
          d="M120 700 C 150 560, 60 470, 150 400 S 320 320, 250 210 S 210 90, 300 70"
          stroke={theme.colors.accent}
          strokeWidth={3}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={ROUTE_LENGTH}
          animatedProps={routeProps}
        />
        {/* Pin de destino (arriba) y punto de origen (medio). */}
        <Circle cx={300} cy={66} r={9} fill={theme.colors.accent} />
        <Circle
          cx={300}
          cy={66}
          r={16}
          stroke={theme.colors.accent}
          strokeOpacity={0.4}
          strokeWidth={2}
          fill="none"
        />
        <Circle
          cx={150}
          cy={400}
          r={6}
          fill={theme.colors.bg}
          stroke={theme.colors.accent}
          strokeWidth={3}
        />
      </Svg>

      <View style={styles.center}>
        {/* El splash anima su propia ruta cian (arriba), por eso el wordmark va sin motivo. */}
        <Animated.View style={[styles.wordmark, wordmarkStyle]}>
          <VeoWordmark size="xl" />
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
  taglineWrap: { position: 'absolute', bottom: 120, left: 0, right: 0, alignItems: 'center' },
  progressWrap: { position: 'absolute', bottom: 56, alignItems: 'center', width: '100%' },
  progressTrack: { width: 72, height: 4, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 2 },
});
