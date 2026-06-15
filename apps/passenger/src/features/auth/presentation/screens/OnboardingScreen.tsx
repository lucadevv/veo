import { Button, Text, useReducedMotion, useTheme } from '@veo/ui-kit';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ImageSourcePropType,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  Extrapolation,
  interpolate,
  type SharedValue,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import { AnimatedDots, FadeInView, PressableScale } from '../../../../shared/presentation/components/motion';
import { VeoWordmark } from '../../../../shared/presentation/components/VeoWordmark';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from 'react-native-svg';
import { useOnboardingStore } from '../stores/onboardingStore';
import { IconCheck, IconShieldCheck } from '../components/icons';
import safetyPhoto from '../assets/onboarding-safety.jpg';
import pricePhoto from '../assets/onboarding-price.jpg';
import privacyPhoto from '../assets/onboarding-privacy.jpg';

const SLIDE_COUNT = 3;

/** Fotos de fondo por slide (Pexels, licencia libre). Cross-fade sincronizado con el scroll. */
const SLIDE_PHOTOS = [safetyPhoto, pricePhoto, privacyPhoto] as const;

/**
 * Capa de FONDO del onboarding: las 3 fotos a pantalla completa con cross-fade ligado al scroll
 * horizontal — la foto de cada slide aparece al deslizar a su página. Encima, un velo oscuro para
 * que el copy sea legible sobre cualquier foto (sin lib de gradiente: velo uniforme + refuerzo
 * inferior, donde vive el texto/acciones). Respeta reduce-motion (foto del primer slide fija).
 */
function OnboardingBackground({
  scrollX,
  pageWidth,
  reduced,
}: {
  scrollX: SharedValue<number>;
  pageWidth: number;
  reduced: boolean;
}): React.JSX.Element {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {SLIDE_PHOTOS.map((source, index) => (
        <BackgroundPhoto
          key={index}
          scrollX={scrollX}
          index={index}
          pageWidth={pageWidth}
          source={source}
          reduced={reduced}
        />
      ))}
      {/* Velo de legibilidad: GRADIENTE real (foto nítida arriba → negro abajo, donde vive el copy
          y las acciones). react-native-svg ya está linkeado, no requiere rebuild nativo. */}
      <Svg style={StyleSheet.absoluteFill}>
        <Defs>
          <SvgLinearGradient id="onbScrim" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#000000" stopOpacity={0.2} />
            <Stop offset="0.4" stopColor="#000000" stopOpacity={0.42} />
            <Stop offset="1" stopColor="#000000" stopOpacity={0.92} />
          </SvgLinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#onbScrim)" />
      </Svg>
    </View>
  );
}

/** Una foto de fondo cuya opacidad sigue el scroll: 1 en su página, 0 en las vecinas (cross-fade). */
function BackgroundPhoto({
  scrollX,
  index,
  pageWidth,
  source,
  reduced,
}: {
  scrollX: SharedValue<number>;
  index: number;
  pageWidth: number;
  source: ImageSourcePropType;
  reduced: boolean;
}): React.JSX.Element {
  const animatedStyle = useAnimatedStyle(() => {
    if (reduced) {
      return { opacity: index === 0 ? 1 : 0 };
    }
    const opacity = interpolate(
      scrollX.value,
      [(index - 1) * pageWidth, index * pageWidth, (index + 1) * pageWidth],
      [0, 1, 0],
      Extrapolation.CLAMP,
    );
    return { opacity };
  });
  return (
    <Animated.Image source={source} style={[StyleSheet.absoluteFill, animatedStyle]} resizeMode="cover" />
  );
}

/** Fila de consentimiento (Ley N.° 29733): card presionable con check. */
function ConsentRow({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <PressableScale
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={onToggle}
      contentStyle={[
        styles.consentRow,
        {
          backgroundColor: theme.colors.surface,
          borderColor: checked ? theme.colors.accent : theme.colors.border,
          borderRadius: theme.radii.md,
          padding: theme.spacing.md,
          gap: theme.spacing.md,
        },
      ]}
    >
      <View
        style={[
          styles.consentBox,
          {
            borderRadius: theme.radii.sm,
            backgroundColor: checked ? theme.colors.accent : 'transparent',
            borderColor: checked ? theme.colors.accent : theme.colors.borderStrong,
          },
        ]}
      >
        {checked ? <IconCheck color={theme.colors.onAccent} size={14} /> : null}
      </View>
      <Text variant="callout" style={styles.consentLabel}>
        {label}
      </Text>
    </PressableScale>
  );
}

/**
 * Onboarding interactivo del pasajero: carrusel horizontal de 3 slides (Seguridad · Auto ·
 * Consentimientos Ley N.° 29733). Cada slide tiene una FOTO DE FONDO a pantalla completa con
 * cross-fade sincronizado al scroll; el copy va sobre el velo, abajo. Dots animados. Los 3
 * consentimientos siguen bloqueando "Aceptar y continuar"; al confirmar persiste el flag con
 * `onboardingStore.complete()` y el `RootNavigator` conmuta de stack (no se navega imperativamente).
 */
export function OnboardingScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const complete = useOnboardingStore((state) => state.complete);
  const recordConsent = useDependency(TOKENS.recordConsentUseCase);

  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollX = useSharedValue(0);
  const dotsProgress = useSharedValue(0);
  const [page, setPage] = useState(0);

  const [data, setData] = useState(false);
  const [camera, setCamera] = useState(false);
  const [location, setLocation] = useState(false);
  const allAccepted = data && camera && location;

  const onScroll = useAnimatedScrollHandler((event) => {
    scrollX.value = event.contentOffset.x;
    dotsProgress.value = width > 0 ? event.contentOffset.x / width : 0;
  });

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = Math.round(event.nativeEvent.contentOffset.x / width);
      setPage(next);
    },
    [width],
  );

  const goToPage = useCallback(
    (target: number) => {
      scrollRef.current?.scrollTo({ x: target * width, animated: true });
    },
    [scrollRef, width],
  );

  /**
   * Acepta y continúa: registra el consentimiento Ley N.° 29733 en el backend (BEST-EFFORT,
   * fuente de verdad servidor) sin bloquear la navegación, y persiste el flag local como caché.
   * `recordConsent.execute` no lanza (reintenta suave y degrada a `null`), así que el onboarding
   * avanza siempre; el `RootNavigator` conmuta de stack al cambiar `completed`.
   */
  const onAccept = useCallback(() => {
    void recordConsent.execute({
      dataProcessing: data,
      inCabinCamera: camera,
      location,
      // Marketing es opt-in EXPLÍCITO posterior (ajustes), no se asume en el onboarding (Ley 29733).
      marketing: false,
    });
    complete();
  }, [recordConsent, data, camera, location, complete]);

  const isLast = page === SLIDE_COUNT - 1;

  return (
    <View style={[styles.screen, { backgroundColor: theme.colors.bg, paddingTop: insets.top }]}>
      {/* Fondo: fotos a pantalla completa con cross-fade por scroll + velo de legibilidad. */}
      <OnboardingBackground scrollX={scrollX} pageWidth={width} reduced={reduced} />

      {/* Cabecera: wordmark + indicador de paso. */}
      <View style={[styles.header, { paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }]}>
        <View style={styles.headerSide} />
        <VeoWordmark size="sm" color="brand" />
        <View style={[styles.headerSide, styles.headerRight]}>
          {page > 0 ? (
            <View
              style={[
                styles.stepPill,
                {
                  backgroundColor: theme.colors.overlay,
                  borderColor: theme.colors.border,
                  borderRadius: theme.radii.pill,
                },
              ]}
            >
              <Text variant="caption" color="inkMuted" tabular>
                {t('onboarding.step', { current: page + 1, total: SLIDE_COUNT })}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      <Animated.ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        onMomentumScrollEnd={onMomentumEnd}
        scrollEventThrottle={16}
        style={styles.flex}
      >
        {/* ── Slide 1 · Seguridad ─────────────────────────────────────── */}
        <View style={[styles.slide, { width, paddingHorizontal: theme.spacing.xl }]}>
          <FadeInView style={styles.copy} offsetY={14}>
            <Text variant="label" color="accent" style={styles.eyebrow}>
              {t('onboarding.safety.eyebrow')}
            </Text>
            <Text variant="display" style={styles.slideTitle}>
              {t('onboarding.safety.title')}
            </Text>
            <Text variant="body" color="inkMuted" align="center" style={styles.slideBody}>
              {t('onboarding.safety.body')}
            </Text>
          </FadeInView>
        </View>

        {/* ── Slide 2 · Auto (solo servicio, sin precio) ──────────────── */}
        <View style={[styles.slide, { width, paddingHorizontal: theme.spacing.xl }]}>
          <View style={styles.copy}>
            <Text variant="title1" style={styles.slideTitleLeft}>
              {t('onboarding.price.title')}
            </Text>
            <Text variant="body" color="inkMuted" style={styles.slideBodyLeft}>
              {t('onboarding.price.body')}
            </Text>
            <View style={{ gap: theme.spacing.sm, marginTop: theme.spacing.lg }}>
              <VehicleOption
                name={t('onboarding.price.car')}
                caption={t('onboarding.price.carTagline')}
                highlighted
              />
            </View>
          </View>
        </View>

        {/* ── Slide 3 · Consentimientos (Ley N.° 29733) ───────────────── */}
        <View style={[styles.slide, { width, paddingHorizontal: theme.spacing.xl }]}>
          <View style={styles.copy}>
            <Text variant="title1" align="center" style={styles.slideTitle}>
              {t('onboarding.consent.title')}
            </Text>
            <Text variant="body" color="inkMuted" align="center" style={styles.slideBody}>
              {t('onboarding.consent.subtitle')}
            </Text>
          </View>
          <Text variant="subhead" color="inkSubtle" style={styles.consentSection}>
            {t('onboarding.consent.sectionLabel')}
          </Text>
          <View style={{ gap: theme.spacing.sm }}>
            <ConsentRow checked={data} label={t('onboarding.consent.data')} onToggle={() => setData((v) => !v)} />
            <ConsentRow checked={camera} label={t('onboarding.consent.camera')} onToggle={() => setCamera((v) => !v)} />
            <ConsentRow
              checked={location}
              label={t('onboarding.consent.location')}
              onToggle={() => setLocation((v) => !v)}
            />
          </View>
          <View style={[styles.legalRow, { marginTop: theme.spacing.lg, gap: theme.spacing.sm }]}>
            <IconShieldCheck color={theme.colors.inkSubtle} onColor={theme.colors.bg} size={16} />
            <Text variant="footnote" color="inkSubtle">
              {t('onboarding.consent.legal')}
            </Text>
          </View>
        </View>
      </Animated.ScrollView>

      {/* Footer fijo: dots + acciones (Saltar / Siguiente · o Aceptar y continuar). */}
      <View
        style={[
          styles.footer,
          {
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: insets.bottom + theme.spacing.md,
            paddingTop: theme.spacing.md,
            gap: theme.spacing.lg,
          },
        ]}
      >
        <AnimatedDots count={SLIDE_COUNT} progress={dotsProgress} />
        {isLast ? (
          <Button
            label={t('onboarding.consent.accept')}
            variant="accent"
            fullWidth
            size="lg"
            disabled={!allAccepted}
            onPress={onAccept}
          />
        ) : (
          <View style={styles.actionRow}>
            <Button
              label={t('onboarding.skip')}
              variant="ghost"
              onPress={() => goToPage(SLIDE_COUNT - 1)}
            />
            <Button
              label={t('onboarding.next')}
              variant="accent"
              size="lg"
              style={styles.nextButton}
              onPress={() => goToPage(page + 1)}
            />
          </View>
        )}
      </View>
    </View>
  );
}

/** Opción de servicio del slide (solo VEO Auto por ahora; sin precio — moto llega después). */
function VehicleOption({
  name,
  caption,
  highlighted = false,
}: {
  name: string;
  caption: string;
  highlighted?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.vehicleRow,
        {
          backgroundColor: theme.colors.surface,
          borderColor: highlighted ? theme.colors.accent : theme.colors.border,
          borderRadius: theme.radii.lg,
          padding: theme.spacing.lg,
        },
      ]}
    >
      <View style={styles.vehicleInfo}>
        <Text variant="bodyStrong">{name}</Text>
        <Text variant="footnote" color="inkMuted">
          {caption}
        </Text>
      </View>
      {/* Sello de confianza (en vez de precio): refuerza el "verificado/seguro" del posicionamiento. */}
      <IconShieldCheck color={theme.colors.accent} onColor={theme.colors.bg} size={22} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerSide: { width: 64 },
  headerRight: { alignItems: 'flex-end' },
  stepPill: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 3 },
  // El contenido se ancla ABAJO (sobre el refuerzo del velo) — la foto respira arriba.
  slide: { flex: 1, justifyContent: 'flex-end', paddingBottom: 24 },
  copy: { gap: 10 },
  eyebrow: { textTransform: 'uppercase', textAlign: 'center' },
  slideTitle: { textAlign: 'center' },
  slideTitleLeft: {},
  slideBody: { maxWidth: 320, alignSelf: 'center' },
  slideBodyLeft: {},
  consentSection: { marginTop: 14, marginBottom: 8 },
  consentRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1 },
  consentBox: {
    width: 26,
    height: 26,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  consentLabel: { flex: 1 },
  legalRow: { flexDirection: 'row', alignItems: 'center' },
  vehicleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
  },
  vehicleInfo: { gap: 2 },
  footer: {},
  actionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  nextButton: { flex: 1, marginLeft: 16 },
});
