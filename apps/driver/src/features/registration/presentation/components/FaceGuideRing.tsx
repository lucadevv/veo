import React, {useEffect} from 'react';
import {StyleSheet, View} from 'react-native';
import Svg, {Circle, Defs, Ellipse, Path, RadialGradient, Stop} from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import {useTheme, useReducedMotion} from '@veo/ui-kit';
import {hexAlpha} from './color';

const SIZE = 260;
const CENTER = SIZE / 2;
const RING_RADIUS = 112;

/** Esquinas (corchetes) que enmarcan la guía facial, como en el visor de cámara. */
function Brackets({color}: {color: string}): React.JSX.Element {
  const m = 14;
  const len = 26;
  const sw = 3;
  const far = SIZE - m;
  return (
    <Svg width={SIZE} height={SIZE} style={StyleSheet.absoluteFill}>
      <Path
        d={`M${m} ${m + len} V${m} H${m + len}`}
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d={`M${far - len} ${m} H${far} V${m + len}`}
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d={`M${m} ${far - len} V${far} H${m + len}`}
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d={`M${far - len} ${far} H${far} V${far - len}`}
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

/** Silueta de rostro/hombros de guía (tenue), centrada en el anillo. */
function FaceSilhouette({color}: {color: string}): React.JSX.Element {
  return (
    <Svg width={SIZE} height={SIZE} style={StyleSheet.absoluteFill} opacity={0.5}>
      <Defs>
        <RadialGradient id="faceFade" cx="50%" cy="42%" r="55%">
          <Stop offset="0%" stopColor={color} stopOpacity={0.9} />
          <Stop offset="100%" stopColor={color} stopOpacity={0.2} />
        </RadialGradient>
      </Defs>
      <Circle cx={CENTER} cy={CENTER - 18} r={42} fill="none" stroke="url(#faceFade)" strokeWidth={2} />
      <Path
        d={`M${CENTER - 58} ${SIZE - 28} c10 -42 36 -52 58 -52 s48 10 58 52`}
        fill="none"
        stroke="url(#faceFade)"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/**
 * Anillo guía de la verificación facial (KYC). Capas: corchetes de visor, silueta de rostro tenue,
 * elipse punteada interior, arcos cian con glow y un anillo de puntos que rota lento (linear,
 * movimiento constante). Respeta reduce-motion deteniendo la rotación.
 */
export function FaceGuideRing(): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const accent = theme.colors.accent;
  const rotation = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      return;
    }
    // Rotación continua: movimiento constante → linear (emil). Lento para no distraer.
    rotation.value = withRepeat(
      withTiming(360, {duration: 9000, easing: Easing.linear}),
      -1,
      false,
    );
  }, [reduced, rotation]);

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{rotateZ: `${rotation.value}deg`}],
  }));

  // Circunferencia para el patrón de puntos (dash 2 / gap 9).
  const circumference = 2 * Math.PI * RING_RADIUS;

  return (
    <View style={styles.wrap} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <FaceSilhouette color={theme.colors.inkMuted} />

      {/* Elipse punteada interior (guía del rostro). */}
      <Svg width={SIZE} height={SIZE} style={StyleSheet.absoluteFill}>
        <Ellipse
          cx={CENTER}
          cy={CENTER}
          rx={66}
          ry={84}
          stroke={hexAlpha(accent, 0.5)}
          strokeWidth={1.5}
          strokeDasharray="2 7"
          fill="none"
        />
      </Svg>

      {/* Arcos cian con glow (arriba y abajo). */}
      <Svg width={SIZE} height={SIZE} style={StyleSheet.absoluteFill}>
        <Circle
          cx={CENTER}
          cy={CENTER}
          r={RING_RADIUS}
          stroke={hexAlpha(accent, 0.22)}
          strokeWidth={3}
          fill="none"
        />
        <Circle
          cx={CENTER}
          cy={CENTER}
          r={RING_RADIUS}
          stroke={accent}
          strokeWidth={4}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${circumference * 0.18} ${circumference * 0.82}`}
          strokeDashoffset={circumference * 0.34}
        />
        <Circle
          cx={CENTER}
          cy={CENTER}
          r={RING_RADIUS}
          stroke={accent}
          strokeWidth={4}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${circumference * 0.18} ${circumference * 0.82}`}
          strokeDashoffset={circumference * 0.84}
        />
      </Svg>

      {/* Anillo de puntos que rota. */}
      <Animated.View style={[StyleSheet.absoluteFill, ringStyle]}>
        <Svg width={SIZE} height={SIZE}>
          <Circle
            cx={CENTER}
            cy={CENTER}
            r={RING_RADIUS + 9}
            stroke={hexAlpha(accent, 0.85)}
            strokeWidth={2}
            strokeLinecap="round"
            fill="none"
            strokeDasharray="2 9"
          />
        </Svg>
      </Animated.View>

      <Brackets color={accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center'},
});
