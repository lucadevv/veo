import React, { useRef, useState } from 'react';
import {
  Image,
  type ImageSourcePropType,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  StatusBar,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Button, Text, useTheme, useReducedMotion } from '@veo/ui-kit';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { useOnboardingStore } from '../state/onboardingStore';

/**
 * Fotos POV reales de conductor (verticales), bundleadas por Metro vía `require`. Una por slide,
 * ya optimizadas (1290px de ancho, <300KB c/u) — pesan ~750KB las tres juntas. Van a sangre
 * completa (cover) ocupando TODO el slide. La ruta sube 5 niveles desde `…/auth/presentation/
 * screens/` hasta la raíz de `apps/driver/` y baja a `assets/images/onboarding/`.
 */
const SLIDE_PHOTOS: Record<string, ImageSourcePropType> = {
  modes: require('../../../../../assets/images/onboarding/slide1.jpg') as ImageSourcePropType,
  price: require('../../../../../assets/images/onboarding/slide2.jpg') as ImageSourcePropType,
  protected: require('../../../../../assets/images/onboarding/slide3.jpg') as ImageSourcePropType,
};

interface SlideContent {
  key: string;
  eyebrow: string;
  title: string;
  body: string;
  photo: ImageSourcePropType;
}

/** Punto de paginación fino: el activo se ensancha y colorea en azul (transición suave). */
function Dot({ active }: { active: boolean }): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const value = useSharedValue(active ? 1 : 0);

  React.useEffect(() => {
    value.value = withTiming(active ? 1 : 0, {
      duration: reduced ? theme.motion.duration.fast : theme.motion.duration.base,
      easing: Easing.bezier(...theme.motion.easing.standard),
    });
  }, [active, reduced, theme, value]);

  const dotStyle = useAnimatedStyle(() => ({
    width: 6 + value.value * 18,
    opacity: 0.35 + value.value * 0.65,
  }));

  return (
    <Animated.View
      style={[
        styles.dot,
        { backgroundColor: active ? theme.colors.accent : theme.colors.inkSubtle },
        dotStyle,
      ]}
    />
  );
}

/**
 * Onboarding del conductor (drv-02), dirección visual TESLA con FOTO real a SANGRE COMPLETA: carrusel
 * paginado de 3 slides, cada uno una sola imagen continua que llena TODO el slide (absoluteFill,
 * cover) — cero costura, cero "dos zonas". El copy (eyebrow azul + título grande `display` + cuerpo
 * gris corto) FLOTA sobre el tercio inferior, legible gracias a un scrim (degradado SVG) que oscurece
 * solo esa franja inferior. El footer (dots + UN CTA primario azul + "Saltar") también flota, absoluto
 * sobre el scrim. Al completar (o saltar) persiste el flag y el RootNavigator conmuta al Login.
 * Respeta safe-area (foto a sangre bajo la status bar, íconos en `light-content`) y reduce-motion.
 */
export const OnboardingScreen = (): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const complete = useOnboardingStore((s) => s.complete);
  const scrollRef = useRef<ScrollView>(null);
  const [index, setIndex] = useState(0);
  // Alto REAL del área de scroll (toda la pantalla), medido vía onLayout: define el alto del slide.
  const [scrollH, setScrollH] = useState(0);
  // Alto REAL del footer flotante, medido vía onLayout: el copy se separa esto para no quedar tapado.
  const [footerH, setFooterH] = useState(0);

  const slides: SlideContent[] = [
    {
      key: 'modes',
      eyebrow: t('onboarding.slides.modes.eyebrow'),
      title: t('onboarding.slides.modes.title'),
      body: t('onboarding.slides.modes.body'),
      photo: SLIDE_PHOTOS.modes!,
    },
    {
      key: 'price',
      eyebrow: t('onboarding.slides.price.eyebrow'),
      title: t('onboarding.slides.price.title'),
      body: t('onboarding.slides.price.body'),
      photo: SLIDE_PHOTOS.price!,
    },
    {
      key: 'protected',
      eyebrow: t('onboarding.slides.protected.eyebrow'),
      title: t('onboarding.slides.protected.title'),
      body: t('onboarding.slides.protected.body'),
      photo: SLIDE_PHOTOS.protected!,
    },
  ];
  const isLast = index === slides.length - 1;

  const onScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(e.nativeEvent.contentOffset.x / width);
    if (next !== index) {
      setIndex(next);
    }
  };

  const onNext = () => {
    if (isLast) {
      complete();
      return;
    }
    scrollRef.current?.scrollTo({ x: width * (index + 1), animated: true });
    setIndex(index + 1);
  };

  // Cuerpo a ancho controlado (line-length cómoda) con margen lateral generoso.
  const sideGutter = theme.spacing['2xl'];
  // Alto del slide: el área medida, con fallback al alto de ventana en el primer render.
  const slideH = scrollH || height;
  // Separación inferior del copy: el footer real + un respiro; fallback razonable antes de medirlo.
  const copyBottomInset = (footerH || (theme.spacing['5xl'] ?? 160)) + theme.spacing.lg;

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.bg }]}>
      <StatusBar barStyle="light-content" />

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScrollEnd}
        onLayout={(e: LayoutChangeEvent) => setScrollH(e.nativeEvent.layout.height)}
        style={styles.flex}
      >
        {slides.map((slide) => (
          <View key={slide.key} style={{ width, height: slideH }}>
            {/* Foto a SANGRE COMPLETA: ABSOLUTA (detrás del copy, fuera del flujo) pero con width/height
                EXPLÍCITOS — así `cover` calza contra el tamaño real del slide y muestra la foto centrada.
                Con `StyleSheet.absoluteFill` (right/bottom:0) el alto no se resolvía y cover zoomeaba mal. */}
            <Image
              source={slide.photo}
              style={{ position: 'absolute', top: 0, left: 0, width, height: slideH }}
              resizeMode="cover"
            />

            {/* Scrim: oscurece SOLO el tercio inferior (más un velo leve arriba para la status bar)
                para que el copy y el footer floten legibles sobre la foto. Decorativo. */}
            <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
              <Defs>
                <LinearGradient id={`photoScrim-${slide.key}`} x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={theme.colors.bg} stopOpacity={0.15} />
                  <Stop offset="0.35" stopColor={theme.colors.bg} stopOpacity={0} />
                  <Stop offset="0.62" stopColor={theme.colors.bg} stopOpacity={0.55} />
                  <Stop offset="0.82" stopColor={theme.colors.bg} stopOpacity={0.9} />
                  <Stop offset="1" stopColor={theme.colors.bg} stopOpacity={1} />
                </LinearGradient>
              </Defs>
              <Rect
                x={0}
                y={0}
                width={width}
                height={slideH}
                fill={`url(#photoScrim-${slide.key})`}
              />
            </Svg>

            {/* Copy anclado ABAJO, flotando sobre el scrim; jerarquía por escala + color. */}
            <View
              style={[
                styles.copyAnchor,
                { paddingHorizontal: sideGutter, paddingBottom: copyBottomInset },
              ]}
            >
              <Reveal delay={60}>
                <Text variant="label" color="accent">
                  {slide.eyebrow.toUpperCase()}
                </Text>
                <Text variant="display" color="ink" style={styles.title}>
                  {slide.title}
                </Text>
                <Text variant="callout" color="inkMuted" style={styles.body}>
                  {slide.body}
                </Text>
              </Reveal>
            </View>
          </View>
        ))}
      </ScrollView>

      {/* Pie FLOTANTE (absoluto) sobre el scrim inferior: hermano del ScrollView, va después para
          quedar por encima. Sin línea divisoria: aire Tesla. */}
      <View
        onLayout={(e: LayoutChangeEvent) => setFooterH(e.nativeEvent.layout.height)}
        style={[
          styles.footer,
          {
            paddingHorizontal: sideGutter,
            paddingBottom: insets.bottom + theme.spacing.xl,
            gap: theme.spacing.xl,
          },
        ]}
      >
        <View style={[styles.dots, { gap: theme.spacing.sm }]}>
          {slides.map((slide, i) => (
            <Dot key={slide.key} active={i === index} />
          ))}
        </View>

        <Button
          label={isLast ? t('onboarding.start') : t('onboarding.next')}
          variant="accent"
          size="lg"
          fullWidth
          onPress={onNext}
        />

        <View style={styles.skipRow}>
          <Button label={t('onboarding.skip')} variant="ghost" onPress={complete} />
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  copyAnchor: { flex: 1, justifyContent: 'flex-end' },
  title: { marginTop: 12 },
  body: { marginTop: 16, maxWidth: 340 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'stretch' },
  dots: { flexDirection: 'row', justifyContent: 'flex-start', alignItems: 'center' },
  dot: { height: 6, borderRadius: 3 },
  skipRow: { alignItems: 'center' },
});
