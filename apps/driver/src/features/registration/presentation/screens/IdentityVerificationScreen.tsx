import React from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import { IconCheck, IconShield } from '../../../../shared/presentation/icons';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import type { RegistrationStackParamList } from '../../../../navigation/types';
import { FACE_CAPTURE_UNAVAILABLE, FACE_PHOTO_GRABBER_UNAVAILABLE } from '../../domain';
import { useRegistrationFaceCapture } from '../hooks/useRegistrationFaceCapture';
import { FaceGuideRing, RegistrationHeader, RegistrationProgress, hexAlpha } from '../components';

type Props = NativeStackScreenProps<RegistrationStackParamList, 'IdentityVerification'>;

/** Ícono de sol (chip "Buena luz"). */
function SunGlyph({ color, size = 18 }: { color: string; size?: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={4} stroke={color} strokeWidth={2} />
      <Path
        d="M12 2v2M12 20v2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Ícono de rostro al frente (chip "Mira al frente"). */
function FaceGlyph({ color, size = 18 }: { color: string; size?: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={11} r={4} stroke={color} strokeWidth={2} />
      <Path
        d="M4 12a8 8 0 0 1 16 0M9 19.5a6 6 0 0 0 6 0"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </Svg>
  );
}

interface HintChipProps {
  icon: React.ReactNode;
  label: string;
}

/** Chip de guía (buena luz / mira al frente) que flanquea el anillo. */
function HintChip({ icon, label }: HintChipProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.hint,
        {
          backgroundColor: theme.colors.surface,
          borderColor: hexAlpha(theme.colors.accent, 0.4),
          borderRadius: theme.radii.md,
          gap: theme.spacing.xs,
        },
      ]}
    >
      {icon}
      <Text variant="caption" color="accent" align="center">
        {label}
      </Text>
    </View>
  );
}

/** Vista previa circular de la foto capturada, enmarcada con el acento (drv-07). */
function CapturePreview({ photoBase64 }: { photoBase64: string }): React.JSX.Element {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <View style={styles.previewWrap}>
      <Image
        accessibilityLabel={t('registration.kyc.captured')}
        source={{ uri: `data:image/jpeg;base64,${photoBase64}` }}
        style={[styles.previewImage, { borderColor: theme.colors.accent }]}
        resizeMode="cover"
      />
      <View
        style={[styles.previewBadge, { backgroundColor: theme.colors.success }]}
        pointerEvents="none"
      >
        <IconCheck size={20} color={theme.colors.onSuccess} strokeWidth={2.4} />
      </View>
    </View>
  );
}

/** Paso 4 del alta: verificación facial / KYC con captura nativa, preview y reintento (drv-07). */
export const IdentityVerificationScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { phase, capture, error, isCapturing, isSubmitting, startCapture, retake, confirm } =
    useRegistrationFaceCapture();

  const isPreview = phase === 'preview' && Boolean(capture?.photoBase64);
  const isBusy = isCapturing || isSubmitting;

  const errorCode = error instanceof Error ? (error as { code?: string }).code : undefined;
  const unavailable =
    errorCode === FACE_CAPTURE_UNAVAILABLE || errorCode === FACE_PHOTO_GRABBER_UNAVAILABLE;

  return (
    <SafeScreen
      header={<RegistrationHeader showLogo onBack={navigation.goBack} peruRight />}
      footer={
        isPreview ? (
          <View style={[styles.previewActions, { gap: theme.spacing.md }]}>
            <Button
              label={t('registration.kyc.retake')}
              variant="secondary"
              fullWidth
              disabled={isSubmitting}
              onPress={retake}
              style={styles.flex}
            />
            <Button
              label={t('registration.kyc.confirm')}
              variant="accent"
              fullWidth
              loading={isSubmitting}
              onPress={confirm}
              style={styles.flex}
            />
          </View>
        ) : undefined
      }
    >
      <View style={[styles.body, { gap: theme.spacing.lg }]}>
        <Reveal>
          <RegistrationProgress current={4} />
        </Reveal>

        <Reveal delay={40} style={styles.intro}>
          <Text variant="caption" color="inkMuted" align="center">
            {t('registration.stepOf', { current: 4, total: 4 })}
          </Text>
          <Text variant="title1" align="center">
            {t('registration.kyc.title')}
          </Text>
          <Text variant="callout" color="inkMuted" align="center">
            {isPreview ? t('registration.kyc.previewSubtitle') : t('registration.kyc.subtitle')}
          </Text>
        </Reveal>

        {isPreview ? (
          <Reveal spring style={styles.ringArea}>
            <CapturePreview photoBase64={capture!.photoBase64!} />
          </Reveal>
        ) : (
          <Reveal delay={120} spring style={styles.ringArea}>
            <FaceGuideRing />
            <View style={styles.hintLeft} pointerEvents="none">
              <HintChip
                icon={<SunGlyph color={theme.colors.accent} />}
                label={t('registration.kyc.goodLight')}
              />
            </View>
            <View style={styles.hintRight} pointerEvents="none">
              <HintChip
                icon={<FaceGlyph color={theme.colors.accent} />}
                label={t('registration.kyc.lookAhead')}
              />
            </View>
          </Reveal>
        )}

        {unavailable ? (
          <Reveal>
            <Banner
              tone="warn"
              title={t('registration.kyc.unavailableTitle')}
              description={t('registration.kyc.unavailableBody')}
            />
          </Reveal>
        ) : error ? (
          <Reveal>
            <Banner
              tone="danger"
              title={t('errors.generic')}
              description={toErrorMessage(error, t)}
            />
          </Reveal>
        ) : (
          <Reveal delay={180} style={[styles.privacy, { gap: theme.spacing.sm }]}>
            <IconShield size={18} color={theme.colors.success} strokeWidth={2} />
            <Text variant="footnote" color="inkMuted" align="center" style={styles.privacyText}>
              {t('registration.kyc.privacy')}
            </Text>
          </Reveal>
        )}

        <View style={styles.spacer} />

        {isPreview ? null : (
          <Reveal delay={220} style={styles.captureWrap}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('registration.kyc.takePhoto')}
              accessibilityState={{ busy: isBusy }}
              disabled={isBusy}
              onPress={startCapture}
              style={styles.captureBtn}
            >
              <View
                style={[
                  styles.captureOuter,
                  { borderColor: theme.colors.accent, opacity: isBusy ? 0.6 : 1 },
                ]}
              >
                {isBusy ? (
                  <ActivityIndicator color={theme.colors.accent} />
                ) : (
                  <View
                    style={[
                      styles.captureInner,
                      { backgroundColor: hexAlpha(theme.colors.accent, 0.18) },
                    ]}
                  />
                )}
              </View>
            </Pressable>
            <Text variant="bodyStrong" color="accent">
              {isCapturing ? t('registration.kyc.capturing') : t('registration.kyc.takePhoto')}
            </Text>
          </Reveal>
        )}
      </View>
    </SafeScreen>
  );
};

const RING = 260;
const PREVIEW = 240;
const styles = StyleSheet.create({
  body: { flex: 1, paddingTop: 12 },
  intro: { gap: 6 },
  ringArea: {
    height: RING,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    width: '100%',
  },
  hint: {
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    width: 76,
  },
  hintLeft: { position: 'absolute', left: 0, top: RING / 2 - 24 },
  hintRight: { position: 'absolute', right: 0, top: RING / 2 - 24 },
  previewWrap: { width: PREVIEW, height: PREVIEW, alignItems: 'center', justifyContent: 'center' },
  previewImage: { width: PREVIEW, height: PREVIEW, borderRadius: PREVIEW / 2, borderWidth: 3 },
  previewBadge: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  privacy: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  privacyText: { flexShrink: 1 },
  spacer: { flex: 1 },
  captureWrap: { alignItems: 'center', gap: 10, paddingBottom: 8 },
  captureBtn: { alignItems: 'center', justifyContent: 'center' },
  captureOuter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureInner: { width: 52, height: 52, borderRadius: 26 },
  previewActions: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
