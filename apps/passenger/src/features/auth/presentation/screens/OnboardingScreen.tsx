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
import mock1 from '../assets/onboarding-mock-1.jpg';
import mock2 from '../assets/onboarding-mock-2.jpg';
import mock3 from '../assets/onboarding-mock-3.jpg';

/** Un slide del carrusel de bienvenida: mockup de la app + título + copy (fuente: `design/veo.pen`). */
interface Slide {
  mock: ImageSourcePropType;
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
    mock: mock1,
    title: 'onboarding.slide1.title',
    body: 'onboarding.slide1.body',
    alt: 'onboarding.slide1.imageAlt',
  },
  {
    mock: mock2,
    title: 'onboarding.slide2.title',
    body: 'onboarding.slide2.body',
    alt: 'onboarding.slide2.imageAlt',
  },
  {
    mock: mock3,
    title: 'onboarding.slide3.title',
    body: 'onboarding.slide3.body',
    alt: 'onboarding.slide3.imageAlt',
  },
];
const SLIDE_COUNT = SLIDES.length;

// Proporción del mockup tomada del diseño (`veo.pen` · DeviceMock 228×430).
const MOCK_RATIO = 430 / 228;

/**
 * Onboarding de bienvenida del pasajero: carrusel de 3 slides de marketing con mockups de la app
 * (seguridad · los 3 modos de viaje · conductores verificados), fiel a `design/veo.pen`
 * (P/Onboarding 1-3). Cada slide centra un mockup con glow de marca + título grotesk + copy.
 * Al terminar (o al Omitir) marca el onboarding completo y el `RootNavigator` conmuta de stack.
 * El consentimiento Ley N.° 29733 ya NO vive acá: se captura en el flujo de auth.
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

  const mockWidth = Math.min(width * 0.6, 240);
  const mockHeight = mockWidth * MOCK_RATIO;

  return (
    <View
      style={[
        styles.screen,
        {backgroundColor: theme.colors.bg, paddingTop: insets.top},
      ]}>
      {/* Barra superior: Omitir a la derecha (fiel al .pen). */}
      <View style={[styles.topBar, {paddingHorizontal: theme.spacing.lg}]}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('onboarding.skip')}
          onPress={complete}
          contentStyle={styles.skipHit}>
          <Text variant="subhead" color="inkSubtle">
            {t('onboarding.skip')}
          </Text>
        </PressableScale>
      </View>

      {/* Carrusel: mockup + copy por slide. */}
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
                styles.mockGlow,
                {
                  width: mockWidth,
                  height: mockHeight,
                  shadowColor: theme.colors.accent,
                },
              ]}>
              <Image
                source={slide.mock}
                accessibilityLabel={t(slide.alt)}
                resizeMode="cover"
                style={[
                  styles.mockImage,
                  {
                    width: mockWidth,
                    height: mockHeight,
                    borderColor: theme.colors.borderStrong,
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
          label={t('onboarding.continue')}
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
  topBar: {
    height: 44,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  skipHit: {paddingVertical: spacing.sm, paddingHorizontal: spacing.xs},
  slide: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing['2xl'],
  },
  // Glow de marca bajo el mockup (emil: sombra de color intencional, no decorativa recargada).
  mockGlow: {
    borderRadius: 32,
    shadowOpacity: 0.32,
    shadowRadius: 30,
    shadowOffset: {width: 0, height: 12},
    elevation: 16,
  },
  mockImage: {borderRadius: 32, borderWidth: 1},
  copy: {alignItems: 'center', gap: spacing.md},
  body: {maxWidth: 320},
  footer: {},
});
