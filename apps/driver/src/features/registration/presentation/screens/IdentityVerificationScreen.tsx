import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  StyleSheet,
  View,
  type NativeSyntheticEvent,
} from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { useIsFocused } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { LivenessAction } from '@veo/shared-types';
import { Banner, Button, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import { IconCheck, IconShield } from '../../../../shared/presentation/icons';
import { Reveal } from '../../../../shared/presentation/components/motion';
import type { RegistrationStackParamList } from '../../../../navigation/types';
import { LIVENESS_FRAME_GRABBER_UNAVAILABLE, RegistrationStep } from '../../domain';
import {
  useRegistrationFaceCapture,
  LivenessPhase,
} from '../hooks/useRegistrationFaceCapture';
import { useRegistrationStepBack } from '../hooks/useRegistrationStepBack';
import { livenessFailReason } from '../kycEnrollError';
import { REGISTRATION_TOTAL_STEPS } from '../state/registrationStore';
import {
  BiometricCameraPreview,
  FaceGuideRing,
  RegistrationExitSheet,
  RegistrationHeader,
  RegistrationProgress,
  hexAlpha,
  type BiometricCameraErrorCode,
  type BiometricCameraErrorPayload,
} from '../components';

type Props = NativeStackScreenProps<RegistrationStackParamList, 'IdentityVerification'>;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * Estado de la cámara nativa en vivo (la preview), gobernado por sus eventos `onCameraReady` /
 * `onCameraError`. Son los 4 estados HONESTOS de cámara, INDEPENDIENTES de la máquina de liveness:
 *  - `starting`: vista montada, esperando a que el nativo abra la sesión.
 *  - `ready`: cámara lista; habilita iniciar el gesto.
 *  - `permission`: permiso de cámara denegado (`E_CAMERA_PERMISSION`) → CTA "Abrir Ajustes".
 *  - `device`: cualquier otro fallo de hardware/config → mensaje genérico de cámara con reintento.
 */
type CameraState = 'starting' | 'ready' | 'permission' | 'device';

/** Mapea el código de error nativo al estado de UI de cámara (permiso vs resto de fallos). */
function cameraStateFromError(
  code: BiometricCameraErrorCode,
): Extract<CameraState, 'permission' | 'device'> {
  return code === 'E_CAMERA_PERMISSION' ? 'permission' : 'device';
}

/**
 * Dirección del cue direccional: hacia dónde "viaja" el gesto. Tiparla deja que el glifo derive su
 * rotación/animación sin strings sueltos.
 */
type CueDirection = 'left' | 'right' | 'vertical' | 'smile';

/**
 * Mapeo TIPADO acción → cue (dirección + clave i18n de accesibilidad). Es un `Record<LivenessAction, …>`
 * EXHAUSTIVO (no if/switch sobre strings): si el contrato agrega una acción nueva a `LivenessAction`,
 * este mapa deja de compilar hasta que se le asigne un cue. El `i18nKey` es la etiqueta accesible/legible
 * del gesto (la INSTRUCCIÓN visible viene del server `instructions`; el cue es la pista direccional).
 */
const ACTION_CUE: Record<LivenessAction, { direction: CueDirection; i18nKey: string }> = {
  [LivenessAction.TURN_LEFT]: { direction: 'left', i18nKey: 'registration.kyc.cueTurnLeft' },
  [LivenessAction.TURN_RIGHT]: { direction: 'right', i18nKey: 'registration.kyc.cueTurnRight' },
  [LivenessAction.NOD]: { direction: 'vertical', i18nKey: 'registration.kyc.cueNod' },
  [LivenessAction.SMILE]: { direction: 'smile', i18nKey: 'registration.kyc.cueSmile' },
};

/**
 * Glifo del cue direccional, animado SUTILMENTE en la dirección del gesto (la flecha "respira" hacia el
 * lado, el nod sube/baja, la sonrisa pulsa). Respeta reduce-motion (queda estático). El glifo no captura
 * toques ni accesibilidad: el label accesible lo lleva el contenedor.
 */
function DirectionalCue({ direction, color }: { direction: CueDirection; color: string }): React.JSX.Element {
  const reduced = useReducedMotion();
  const shift = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      shift.value = 0;
      return;
    }
    // Vaivén suave y continuo (ease-in-out): comunica la dirección del gesto sin distraer.
    shift.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 720, easing: Easing.inOut(Easing.quad) }),
        withTiming(0, { duration: 720, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
      false,
    );
  }, [reduced, shift]);

  const animatedStyle = useAnimatedStyle(() => {
    const amount = shift.value * 8;
    switch (direction) {
      case 'left':
        return { transform: [{ translateX: -amount }] };
      case 'right':
        return { transform: [{ translateX: amount }] };
      case 'vertical':
        return { transform: [{ translateY: amount }] };
      case 'smile':
        return { transform: [{ scale: 1 + shift.value * 0.12 }] };
    }
  });

  return (
    <Animated.View style={animatedStyle}>
      <CueGlyph direction={direction} color={color} />
    </Animated.View>
  );
}

/** Dibuja el glifo SVG del cue según la dirección (flecha izq/der, nod arriba-abajo, sonrisa). */
function CueGlyph({ direction, color }: { direction: CueDirection; color: string }): React.JSX.Element {
  const size = 30;
  if (direction === 'left') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path d="M15 5 8 12l7 7" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    );
  }
  if (direction === 'right') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path d="M9 5l7 7-7 7" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    );
  }
  if (direction === 'vertical') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path d="M12 4v16M6 9l6-6 6 6M6 15l6 6 6-6" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    );
  }
  // smile
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M8 14c1.2 1.6 2.6 2.4 4 2.4s2.8-.8 4-2.4" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
      <Circle cx={9} cy={9.5} r={1} fill={color} />
      <Circle cx={15} cy={9.5} r={1} fill={color} />
    </Svg>
  );
}

const RING = 260;
const PREVIEW = 240;
const PROGRESS_RADIUS = 124;
const PROGRESS_CIRCUMFERENCE = 2 * Math.PI * PROGRESS_RADIUS;

/**
 * Anillo de progreso REAL de la captura: el trazo se llena con `progress` (0..1) que reporta el grabber
 * mientras entrega frames (NO un progreso falso por temporizador). Se monta solo durante `performing`.
 */
function CaptureProgressRing({ progress, color }: { progress: number; color: string }): React.JSX.Element {
  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: PROGRESS_CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, progress))),
  }));
  return (
    <Svg width={RING} height={RING} style={StyleSheet.absoluteFill}>
      <AnimatedCircle
        cx={RING / 2}
        cy={RING / 2}
        r={PROGRESS_RADIUS}
        stroke={color}
        strokeWidth={5}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={PROGRESS_CIRCUMFERENCE}
        animatedProps={animatedProps}
        // Empieza arriba (12 en punto) y avanza en sentido horario.
        transform={`rotate(-90 ${RING / 2} ${RING / 2})`}
      />
    </Svg>
  );
}

/**
 * Cámara frontal EN VIVO recortada en círculo, con el anillo guía (`FaceGuideRing`) SUPERPUESTO. El
 * conductor se ve a sí mismo (selfie natural: `mirrored`). La preview se MONTA solo mientras la pantalla
 * está enfocada Y el flujo está en `ready`/`performing` (`mounted`): al navegar fuera o cambiar de fase
 * se desmonta para LIBERAR la cámara frontal (no debe quedar abierta y chocar con WebRTC / el gate de turno).
 */
function LiveFacePreview({
  mounted,
  progress,
  showProgress,
  onReady,
  onError,
}: {
  mounted: boolean;
  progress: number;
  showProgress: boolean;
  onReady: () => void;
  onError: (payload: BiometricCameraErrorPayload) => void;
}): React.JSX.Element {
  const theme = useTheme();

  const handleReady = useCallback(() => {
    onReady();
  }, [onReady]);

  const handleError = useCallback(
    (event: NativeSyntheticEvent<BiometricCameraErrorPayload>) => {
      onError(event.nativeEvent);
    },
    [onError],
  );

  return (
    <View style={styles.liveWrap}>
      <View style={[styles.liveCircle, { borderColor: hexAlpha(theme.colors.accent, 0.6) }]}>
        {mounted ? (
          <BiometricCameraPreview
            mirrored
            style={StyleSheet.absoluteFill}
            onCameraReady={handleReady}
            onCameraError={handleError}
          />
        ) : null}
      </View>
      {/* El anillo guía va por ENCIMA del video, sin capturar toques. */}
      <View style={styles.ringOverlay} pointerEvents="none">
        <FaceGuideRing />
      </View>
      {/* Anillo de progreso real (solo mientras se ejecuta el gesto). */}
      {showProgress ? (
        <View style={styles.ringOverlay} pointerEvents="none">
          <CaptureProgressRing progress={progress} color={theme.colors.success} />
        </View>
      ) : null}
    </View>
  );
}

/** Marca de éxito (check) con micro-interacción de aparición (spring). Reemplaza la preview de la foto. */
function SuccessCheck(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.previewWrap}>
      <View
        style={[
          styles.successDisc,
          { backgroundColor: hexAlpha(theme.colors.success, 0.16), borderColor: theme.colors.success },
        ]}
      >
        <IconCheck size={64} color={theme.colors.success} strokeWidth={2.4} />
      </View>
    </View>
  );
}

/** Paso 4 del alta: verificación de identidad con LIVENESS REACTIVO (reto → gesto → captura → enroll). */
// El back ya no usa el prop `navigation` (lo maneja `useRegistrationStepBack` con `useNavigation`); el
// tipo `Props` se mantiene para documentar que es la pantalla del paso `IdentityVerification`.
export const IdentityVerificationScreen = (_props: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const {
    phase,
    action,
    instructions,
    captureProgress,
    error,
    errorSource,
    enrollErrorKind,
    isSubmitting,
    start,
    retry,
  } = useRegistrationFaceCapture();

  // La cámara en vivo SOLO se monta mientras la pantalla está enfocada: al salir (back, éxito, exit)
  // pierde el foco y la preview se desmonta → el nativo libera la cámara frontal.
  const isFocused = useIsFocused();

  // Estado de la cámara nativa (4 estados HONESTOS: iniciando / lista / permiso denegado / error de dispositivo).
  const [cameraState, setCameraState] = useState<CameraState>('starting');

  const handleCameraReady = useCallback(() => {
    setCameraState('ready');
  }, []);

  const handleCameraError = useCallback((payload: BiometricCameraErrorPayload) => {
    setCameraState(cameraStateFromError(payload.code));
  }, []);

  // Reintentar tras un fallo de cámara: volvemos a "iniciando" para forzar un nuevo ciclo de eventos.
  const retryCamera = useCallback(() => {
    setCameraState('starting');
  }, []);

  const openSettings = useCallback(() => {
    void Linking.openSettings();
  }, []);

  // Back robusto del paso: reconstruye la pila al reanudar y nunca dispara un GO_BACK muerto.
  const back = useRegistrationStepBack();

  // Fases de la máquina de liveness.
  const isRequesting = phase === LivenessPhase.REQUESTING_CHALLENGE;
  const isReady = phase === LivenessPhase.READY;
  const isPerforming = phase === LivenessPhase.PERFORMING;
  const isSuccess = phase === LivenessPhase.SUCCESS;
  const isFailed = phase === LivenessPhase.FAILED;

  // La preview en vivo se muestra mientras se prepara/ejecuta el gesto (ready/performing). En éxito,
  // envío y fallo de enroll se muestra otra cosa (check / spinner / banner).
  const showLivePreview = isReady || isPerforming;
  // El gesto solo se habilita con cámara lista, reto recibido (ready) y sin trabajo en curso.
  const cameraReady = cameraState === 'ready';
  const canStart = isReady && cameraReady;

  // Error de "módulo nativo no disponible" durante la captura: banner informativo (no de cámara).
  const errorCode = error instanceof Error ? (error as { code?: string }).code : undefined;
  const unavailable = errorSource === 'capture' && errorCode === LIVENESS_FRAME_GRABBER_UNAVAILABLE;

  // Cue direccional tipado derivado de la acción del reto (sin if/string).
  const cue = action ? ACTION_CUE[action] : null;

  return (
    <>
      <SafeScreen header={<RegistrationHeader showLogo onBack={back.onBack} peruRight />}>
        <View style={[styles.body, { gap: theme.spacing.lg }]}>
          <Reveal>
            <RegistrationProgress current={RegistrationStep.IDENTITY_VERIFICATION} />
          </Reveal>

          <Reveal delay={40} style={styles.intro}>
            <Text variant="caption" color="inkMuted" align="center">
              {t('registration.stepOf', {
                current: RegistrationStep.IDENTITY_VERIFICATION,
                total: REGISTRATION_TOTAL_STEPS,
              })}
            </Text>
            <Text variant="title1" align="center">
              {t('registration.kyc.title')}
            </Text>
            <Text variant="callout" color="inkMuted" align="center">
              {/* El prompt LIVE viene del servidor (`instructions`); si aún no llegó, el genérico i18n. */}
              {showLivePreview && instructions
                ? instructions
                : t('registration.kyc.instructionLabel')}
            </Text>
          </Reveal>

          {/* Zona del anillo: cambia por fase, sin perder el centro. */}
          {isSuccess ? (
            <Reveal spring style={styles.ringArea}>
              <SuccessCheck />
            </Reveal>
          ) : isSubmitting ? (
            <Reveal spring style={styles.ringArea}>
              <View style={styles.previewWrap}>
                <ActivityIndicator size="large" color={theme.colors.accent} />
              </View>
            </Reveal>
          ) : isRequesting ? (
            <Reveal style={styles.ringArea}>
              <View style={styles.previewWrap}>
                <ActivityIndicator size="large" color={theme.colors.accent} />
              </View>
            </Reveal>
          ) : (
            <Reveal delay={120} spring style={styles.ringArea}>
              <LiveFacePreview
                mounted={isFocused && showLivePreview}
                progress={captureProgress}
                showProgress={isPerforming}
                onReady={handleCameraReady}
                onError={handleCameraError}
              />
              {/* Cue direccional tipado (accesible) flanqueando el anillo. */}
              {cue ? (
                <View
                  style={styles.cueBadge}
                  accessibilityRole="image"
                  accessibilityLabel={t(cue.i18nKey)}
                >
                  <DirectionalCue direction={cue.direction} color={theme.colors.accent} />
                </View>
              ) : null}
            </Reveal>
          )}

          {renderStatus({
            t,
            theme,
            unavailable,
            cameraState,
            phase,
            enrollErrorKind: errorSource === 'enroll' ? enrollErrorKind : null,
            livenessReason: errorSource === 'enroll' ? livenessFailReason(error) : null,
            isFailed,
            onOpenSettings: openSettings,
            onRetryCamera: retryCamera,
            onRetry: retry,
          })}

          <View style={styles.spacer} />

          {/* CTA primaria de iniciar el gesto (solo en `ready`). */}
          {isReady ? (
            <Reveal delay={200} style={styles.ctaWrap}>
              <Button
                label={cameraReady ? t('registration.kyc.start') : t('registration.kyc.startingCamera')}
                variant="accent"
                fullWidth
                disabled={!canStart}
                onPress={() => void start()}
              />
            </Reveal>
          ) : null}

          {/* Etiqueta de progreso del gesto (acompaña el anillo). */}
          {isPerforming ? (
            <Reveal style={styles.ctaWrap}>
              <Text variant="bodyStrong" color="accent" align="center">
                {t('registration.kyc.performing')}
              </Text>
            </Reveal>
          ) : null}
        </View>
      </SafeScreen>
      <RegistrationExitSheet exit={back.exit} />
    </>
  );
};

interface StatusArgs {
  t: ReturnType<typeof useTranslation>['t'];
  theme: ReturnType<typeof useTheme>;
  unavailable: boolean;
  cameraState: CameraState;
  phase: LivenessPhase;
  enrollErrorKind: ReturnType<typeof useRegistrationFaceCapture>['enrollErrorKind'];
  livenessReason: string | null;
  isFailed: boolean;
  onOpenSettings: () => void;
  onRetryCamera: () => void;
  onRetry: () => void;
}

/**
 * Banda de estado bajo el anillo. Prioridad:
 *  éxito (banner de éxito) → módulo no disponible → fallo de reto/captura/enroll (liveness/rostro/red/
 *  genérico) con "Intentar de nuevo" → permiso de cámara → error de dispositivo de cámara → privacidad.
 * Cada caso es un banner/aviso DISTINTO y accionable. El reintento de liveness pide un reto NUEVO.
 */
function renderStatus({
  t,
  theme,
  unavailable,
  cameraState,
  phase,
  enrollErrorKind,
  livenessReason,
  isFailed,
  onOpenSettings,
  onRetryCamera,
  onRetry,
}: StatusArgs): React.JSX.Element | null {
  if (phase === LivenessPhase.SUCCESS) {
    return (
      <Reveal spring>
        <Banner
          tone="success"
          title={t('registration.kyc.successTitle')}
          description={t('registration.kyc.successBody')}
        />
      </Reveal>
    );
  }

  if (phase === LivenessPhase.SUBMITTING) {
    return (
      <Reveal>
        <Text variant="callout" color="inkMuted" align="center">
          {t('registration.kyc.submitting')}
        </Text>
      </Reveal>
    );
  }

  if (phase === LivenessPhase.REQUESTING_CHALLENGE) {
    return (
      <Reveal>
        <Text variant="callout" color="inkMuted" align="center">
          {t('registration.kyc.preparing')}
        </Text>
      </Reveal>
    );
  }

  // Módulo nativo no enlazado durante la captura: banner informativo con reintento (nuevo reto).
  if (isFailed && unavailable) {
    return (
      <Reveal>
        <Banner
          tone="warn"
          title={t('registration.kyc.unavailableTitle')}
          description={t('registration.kyc.unavailableBody')}
          action={{ label: t('registration.kyc.tryAgain'), onPress: onRetry }}
        />
      </Reveal>
    );
  }

  // Errores del backend al confirmar (enroll). El reintento pide un reto NUEVO (los retos son de un solo uso).
  if (isFailed && enrollErrorKind) {
    if (enrollErrorKind === 'liveness') {
      return (
        <Reveal>
          <Banner
            tone="warn"
            title={t('registration.kyc.livenessFailTitle')}
            // Mensaje i18n humano; si el server trae un reason, se ANEXA (nunca como único texto crudo).
            description={
              livenessReason
                ? `${t('registration.kyc.livenessFailBody')} (${livenessReason})`
                : t('registration.kyc.livenessFailBody')
            }
            action={{ label: t('registration.kyc.tryAgain'), onPress: onRetry }}
          />
        </Reveal>
      );
    }
    if (enrollErrorKind === 'face') {
      return (
        <Reveal>
          <Banner
            tone="warn"
            title={t('registration.kyc.enrollFaceTitle')}
            description={t('registration.kyc.enrollFaceBody')}
            action={{ label: t('registration.kyc.tryAgain'), onPress: onRetry }}
          />
        </Reveal>
      );
    }
    if (enrollErrorKind === 'network') {
      return (
        <Reveal>
          <Banner
            tone="danger"
            title={t('registration.kyc.enrollNetworkTitle')}
            description={t('registration.kyc.enrollNetworkBody')}
            action={{ label: t('registration.kyc.tryAgain'), onPress: onRetry }}
          />
        </Reveal>
      );
    }
    if (enrollErrorKind === 'incomplete') {
      return (
        <Reveal>
          <Banner
            tone="warn"
            title={t('registration.kyc.enrollIncompleteTitle')}
            description={t('registration.kyc.enrollIncompleteBody')}
          />
        </Reveal>
      );
    }
    return (
      <Reveal>
        <Banner
          tone="danger"
          title={t('registration.kyc.enrollGenericTitle')}
          description={t('registration.kyc.enrollGenericBody')}
          action={{ label: t('registration.kyc.tryAgain'), onPress: onRetry }}
        />
      </Reveal>
    );
  }

  // Fallo al pedir el reto (red/backend): banner de reto con reintento.
  if (isFailed) {
    return (
      <Reveal>
        <Banner
          tone="danger"
          title={t('registration.kyc.challengeErrorTitle')}
          description={t('registration.kyc.challengeErrorBody')}
          action={{ label: t('registration.kyc.tryAgain'), onPress: onRetry }}
        />
      </Reveal>
    );
  }

  // Permiso de cámara denegado: CTA específico a Ajustes (distinto del banner genérico).
  if (cameraState === 'permission') {
    return (
      <Reveal>
        <Banner
          tone="warn"
          title={t('registration.kyc.permissionTitle')}
          description={t('registration.kyc.permissionBody')}
          action={{ label: t('registration.kyc.openSettings'), onPress: onOpenSettings }}
        />
      </Reveal>
    );
  }

  // Fallo de hardware/config de la cámara: mensaje claro con reintento.
  if (cameraState === 'device') {
    return (
      <Reveal>
        <Banner
          tone="danger"
          title={t('registration.kyc.cameraErrorTitle')}
          description={t('registration.kyc.cameraErrorBody')}
          action={{ label: t('registration.kyc.retryCamera'), onPress: onRetryCamera }}
        />
      </Reveal>
    );
  }

  return (
    <Reveal delay={180} style={[styles.privacy, { gap: theme.spacing.sm }]}>
      <IconShield size={18} color={theme.colors.success} strokeWidth={2} />
      <Text variant="footnote" color="inkMuted" align="center" style={styles.privacyText}>
        {t('registration.kyc.privacy')}
      </Text>
    </Reveal>
  );
}

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
  liveWrap: { width: RING, height: RING, alignItems: 'center', justifyContent: 'center' },
  // El video se recorta en círculo (el diámetro del anillo de la guía) para encajar con la estética.
  liveCircle: {
    width: PREVIEW,
    height: PREVIEW,
    borderRadius: PREVIEW / 2,
    borderWidth: 1,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  ringOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cueBadge: { position: 'absolute', bottom: 6, alignSelf: 'center' },
  previewWrap: { width: PREVIEW, height: PREVIEW, alignItems: 'center', justifyContent: 'center' },
  successDisc: {
    width: PREVIEW,
    height: PREVIEW,
    borderRadius: PREVIEW / 2,
    borderWidth: 3,
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
  ctaWrap: { paddingBottom: 8 },
});
