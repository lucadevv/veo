import {Button, spacing, Text, useTheme} from '@veo/ui-kit';
import React, {useCallback, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {
  Image,
  type ImageSourcePropType,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Animated, {
  useAnimatedRef,
  useAnimatedScrollHandler,
  useSharedValue,
} from 'react-native-reanimated';
import {
  AnimatedDots,
  FadeInView,
  PressableScale,
} from '../../../../shared/presentation/components/motion';
import {useOnboardingStore} from '../stores/onboardingStore';
import photo1 from '../assets/onboarding-photo-1.jpg';
import photo2 from '../assets/onboarding-photo-2.jpg';
import photo3 from '../assets/onboarding-photo-3.jpg';

/** Un slide del carrusel de bienvenida: foto + título + copy (fuente: `design/veo.pen`). */
interface Slide {
  photo: ImageSourcePropType;
  title:
    | 'onboarding.slide1.title'
    | 'onboarding.slide2.title'
    | 'onboarding.slide3.title';
  body:
    | 'onboarding.slide1.body'
    | 'onboarding.slide2.body'
    | 'onboarding.slide3.body';
  alt:
    | 'onboarding.slide1.imageAlt'
    | 'onboarding.slide2.imageAlt'
    | 'onboarding.slide3.imageAlt';
}

const SLIDES: readonly Slide[] = [
  {
    photo: photo1,
    title: 'onboarding.slide1.title',
    body: 'onboarding.slide1.body',
    alt: 'onboarding.slide1.imageAlt',
  },
  {
    photo: photo2,
    title: 'onboarding.slide2.title',
    body: 'onboarding.slide2.body',
    alt: 'onboarding.slide2.imageAlt',
  },
  {
    photo: photo3,
    title: 'onboarding.slide3.title',
    body: 'onboarding.slide3.body',
    alt: 'onboarding.slide3.imageAlt',
  },
];
const SLIDE_COUNT = SLIDES.length;

// Proporción de la foto: portrait 3:4 (assets 1200×1600) para un retrato limpio sin recortar caras.
const PHOTO_RATIO = 4 / 3;

/**
 * Onboarding de bienvenida del pasajero: carrusel de 3 slides de marketing (seguridad · los 3 modos
 * de viaje · conductores verificados). Cada slide centra una FOTO en card redondeada con halo teal
 * de marca + título grotesk + copy, con entrada animada (FadeInView). Al terminar (o al Omitir)
 * marca el onboarding completo y el `RootNavigator` conmuta de stack. El consentimiento Ley N.° 29733
 * ya NO vive acá: se captura en el flujo de auth.
 */
export function OnboardingScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const insets = useSafeAreaInsets();
  const {width} = useWindowDimensions();
  const complete = useOnboardingStore(state => state.complete);

  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollX = useSharedValue(0);
  const dotsProgress = useSharedValue(0);
  const [page, setPage] = useState(0);

  const onScroll = useAnimatedScrollHandler(event => {
    scrollX.value = event.contentOffset.x;
    dotsProgress.value = width > 0 ? event.contentOffset.x / width : 0;
  });

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      setPage(Math.round(event.nativeEvent.contentOffset.x / width));
    },
    [width],
  );

  const goToPage = useCallback(
    (target: number) => {
      scrollRef.current?.scrollTo({x: target * width, animated: true});
    },
    [scrollRef, width],
  );

  const isLast = page === SLIDE_COUNT - 1;

  const onPrimary = useCallback(() => {
    if (isLast) {
      complete();
    } else {
      goToPage(page + 1);
    }
  }, [isLast, complete, goToPage, page]);

  const photoWidth = Math.min(width * 0.74, 300);
  const photoHeight = photoWidth * PHOTO_RATIO;

  return (
    <View
      style={[
        styles.screen,
        {backgroundColor: theme.colors.bg, paddingTop: insets.top},
      ]}>
      {/* Carrusel: foto + copy por slide. */}
      <Animated.ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        onMomentumScrollEnd={onMomentumEnd}
        scrollEventThrottle={16}
        style={styles.flex}>
        {SLIDES.map(slide => (
          <View
            key={slide.title}
            style={[
              styles.slide,
              {width, paddingHorizontal: theme.spacing.xl},
            ]}>
            <View
              style={[
                styles.photoGlow,
                {
                  width: photoWidth,
                  height: photoHeight,
                  shadowColor: theme.colors.accent,
                },
              ]}>
              <Image
                source={slide.photo}
                accessibilityLabel={t(slide.alt)}
                resizeMode="cover"
                style={[
                  styles.photo,
                  {
                    width: photoWidth,
                    height: photoHeight,
                    borderColor: theme.colors.border,
                  },
                ]}
              />
            </View>

            <FadeInView style={styles.copy} offsetY={12}>
              <Text variant="title1" align="center">
                {t(slide.title)}
              </Text>
              <Text
                variant="body"
                color="inkMuted"
                align="center"
                style={styles.body}>
                {t(slide.body)}
              </Text>
            </FadeInView>
          </View>
        ))}
      </Animated.ScrollView>

      {/* Omitir FLOTANTE arriba a la derecha (sin barra: flota sobre el contenido). */}
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={t('onboarding.skip')}
        onPress={complete}
        style={[styles.skipFloat, {top: insets.top + 4, right: theme.spacing.lg}]}
        contentStyle={styles.skipHit}>
        <Text variant="subhead" color="inkMuted">
          {t('onboarding.skip')}
        </Text>
      </PressableScale>

      {/* Footer fijo: dots + Continuar. */}
      <View
        style={[
          styles.footer,
          {
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: insets.bottom + theme.spacing.lg,
            gap: theme.spacing.xl,
          },
        ]}>
        <AnimatedDots count={SLIDE_COUNT} progress={dotsProgress} />
        <Button
          label={isLast ? t('onboarding.createAccount') : t('onboarding.continue')}
          variant="accent"
          fullWidth
          size="lg"
          onPress={onPrimary}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1},
  flex: {flex: 1},
  skipFloat: {position: 'absolute', zIndex: 10},
  skipHit: {paddingVertical: spacing.sm, paddingHorizontal: spacing.sm},
  slide: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing['2xl'],
  },
  // Halo teal de marca bajo la foto (emil: sombra de color intencional, suave, no recargada).
  photoGlow: {
    borderRadius: 32,
    shadowOpacity: 0.22,
    shadowRadius: 28,
    shadowOffset: {width: 0, height: 14},
    elevation: 14,
  },
  photo: {borderRadius: 32, borderWidth: 1},
  copy: {alignItems: 'center', gap: spacing.md},
  body: {maxWidth: 320},
  footer: {},
});
