import React, { useRef, useState } from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Button, SafeScreen, Text, useTheme, useReducedMotion } from '@veo/ui-kit';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { VeoWordmark } from '../../../../shared/presentation/components/VeoWordmark';
import { useOnboardingStore } from '../state/onboardingStore';

interface SlideContent {
  key: string;
  title: string;
  body: string;
  art: 'earnings' | 'protected';
}

/** Ilustración line-art de cada slide (motivo de ruta + ciudad, evitando figuras "dibujadas"). */
function SlideArt({
  variant,
  color,
  ink,
}: {
  variant: SlideContent['art'];
  color: string;
  ink: string;
}): React.JSX.Element {
  return (
    <Svg width="100%" height={200} viewBox="0 0 320 200" fill="none">
      {/* Silueta de ciudad. */}
      <Path
        d="M0 168h320"
        stroke={ink}
        strokeWidth={1.5}
        strokeOpacity={0.25}
        strokeLinecap="round"
      />
      <Rect
        x={184}
        y={120}
        width={20}
        height={48}
        stroke={ink}
        strokeWidth={1.5}
        strokeOpacity={0.35}
      />
      <Rect
        x={210}
        y={100}
        width={24}
        height={68}
        stroke={ink}
        strokeWidth={1.5}
        strokeOpacity={0.35}
      />
      <Rect
        x={240}
        y={132}
        width={18}
        height={36}
        stroke={ink}
        strokeWidth={1.5}
        strokeOpacity={0.35}
      />
      {/* Ruta cian que sube hacia el pin. */}
      <Path
        d="M20 168 C 80 168, 70 96, 140 96 S 250 60, 280 30"
        stroke={color}
        strokeWidth={2.5}
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d="M20 168 C 80 168, 70 96, 140 96 S 250 60, 280 30"
        stroke={color}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray="1 10"
        strokeOpacity={0.6}
        fill="none"
      />
      <Circle cx={283} cy={28} r={7} fill={color} />
      <Circle cx={20} cy={168} r={5} fill="none" stroke={color} strokeWidth={2.5} />
      {variant === 'earnings' ? (
        <>
          {/* Moneda "S/" de ganancias. */}
          <Circle cx={92} cy={70} r={28} stroke={color} strokeWidth={2.5} />
          <Path
            d="M101 60c-3-4-13-4-15 1-2 4 3 6 7 7 5 1 9 3 7 8-2 4-12 5-16 1"
            stroke={color}
            strokeWidth={2.5}
            strokeLinecap="round"
            fill="none"
          />
          <Path d="M96 50v36" stroke={color} strokeWidth={2.5} strokeLinecap="round" />
        </>
      ) : (
        <>
          {/* Escudo de protección. */}
          <Path
            d="M92 44 70 53v20c0 14 10 23 22 28 12-5 22-14 22-28V53L92 44Z"
            stroke={color}
            strokeWidth={2.5}
            strokeLinejoin="round"
            fill="none"
          />
          <Path
            d="M83 73l6 6 12-13"
            stroke={color}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </>
      )}
    </Svg>
  );
}

/** Chip de "Ganancias de hoy" mostrado sobre la ilustración del primer slide. */
function EarningsChip(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View
      style={[
        styles.chip,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          padding: theme.spacing.lg,
          gap: theme.spacing.lg,
        },
      ]}
    >
      <View style={styles.chipText}>
        <Text variant="footnote" color="inkMuted">
          {t('onboarding.earningsLabel')}
        </Text>
        <Text variant="title2" tabular>
          {t('onboarding.earningsValue')}
        </Text>
      </View>
      <View style={[styles.chipArrow, { backgroundColor: theme.colors.accent }]}>
        <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
          <Path
            d="M12 19V6M6 12l6-6 6 6"
            stroke={theme.colors.onAccent}
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </View>
    </View>
  );
}

/** Punto de paginación animado (el activo se ensancha y colorea en cian). */
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
    width: 8 + value.value * 16,
    opacity: 0.4 + value.value * 0.6,
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
 * Onboarding del conductor (drv-02). Carrusel paginado de 2 slides con dots animados y acciones
 * "Saltar"/"Siguiente". Al completar (o saltar) persiste el flag en el store y el RootNavigator
 * conmuta al Login. La primera diapositiva replica el mockup (ganancias del día).
 */
export const OnboardingScreen = (): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const complete = useOnboardingStore((s) => s.complete);
  const scrollRef = useRef<ScrollView>(null);
  const [index, setIndex] = useState(0);

  const slides: SlideContent[] = [
    {
      key: 'earnings',
      title: t('onboarding.slides.earnings.title'),
      body: t('onboarding.slides.earnings.body'),
      art: 'earnings',
    },
    {
      key: 'protected',
      title: t('onboarding.slides.protected.title'),
      body: t('onboarding.slides.protected.body'),
      art: 'protected',
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

  return (
    <SafeScreen
      padded={false}
      footer={
        <View
          style={[styles.footer, { paddingHorizontal: theme.spacing.xl, gap: theme.spacing.lg }]}
        >
          <Button label={t('onboarding.skip')} variant="ghost" onPress={complete} />
          <View style={styles.footerNext}>
            <Button
              label={isLast ? t('onboarding.start') : t('onboarding.next')}
              variant="accent"
              fullWidth
              onPress={onNext}
            />
          </View>
        </View>
      }
    >
      <View style={[styles.brand, { paddingTop: theme.spacing.sm }]}>
        <VeoWordmark size="sm" />
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScrollEnd}
        style={styles.flex}
      >
        {slides.map((slide) => (
          <View
            key={slide.key}
            style={[styles.slide, { width, paddingHorizontal: theme.spacing.xl }]}
          >
            <View style={styles.art}>
              <SlideArt variant={slide.art} color={theme.colors.accent} ink={theme.colors.ink} />
            </View>
            {slide.art === 'earnings' ? <EarningsChip /> : null}
            <Reveal delay={60} style={[styles.copy, { gap: theme.spacing.sm }]}>
              <Text variant="title1">{slide.title}</Text>
              <Text variant="body" color="inkMuted">
                {slide.body}
              </Text>
            </Reveal>
          </View>
        ))}
      </ScrollView>

      <View style={[styles.dots, { gap: theme.spacing.sm }]}>
        {slides.map((slide, i) => (
          <Dot key={slide.key} active={i === index} />
        ))}
      </View>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  brand: { alignItems: 'center' },
  slide: { justifyContent: 'center', gap: 24 },
  art: { alignItems: 'center' },
  copy: {},
  chip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch' },
  chipText: { flex: 1, gap: 2 },
  chipArrow: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 16,
  },
  dot: { height: 8, borderRadius: 4 },
  footer: { flexDirection: 'row', alignItems: 'center' },
  footerNext: { flex: 1 },
});
