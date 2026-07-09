import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import { IconCheck, IconShield } from '../../../../shared/presentation/icons';
import { Reveal } from '../../../../shared/presentation/components/motion';
import type { RegistrationStackParamList } from '../../../../navigation/types';
import { FACE_PHOTO_GRABBER_UNAVAILABLE, RegistrationStep } from '../../domain';
import { useRegistrationFaceCapture, SelfiePhase } from '../hooks/useRegistrationFaceCapture';
import { useRegistrationStepBack } from '../hooks/useRegistrationStepBack';
import { ORDERED_STEPS } from '../../../../navigation/registrationStackRoutes';
import {
  useRegistrationWizardPageOptional,
  type WizardPageFooter,
} from './RegistrationWizardContext';
import {
  BiometricCameraPreview,
  type BiometricCameraErrorCode,
  type BiometricCameraErrorPayload,
  RegistrationExitSheet,
  RegistrationHeader,
  RegistrationProgress,
} from '../components';
import { hexAlpha } from '../../../../shared/presentation/color';

// `Partial`: en modo EMBEBIDO (wizard) la pantalla se renderiza SIN `navigation`/`route`. Standalone: normales.
type Props = Partial<NativeStackScreenProps<RegistrationStackParamList, 'IdentityVerification'>>;

/**
 * Estado de la cámara frontal nativa (`BiometricCameraPreview`), gobernado por sus eventos
 * (`onCameraReady` / `onCameraError`). Son los estados HONESTOS de cámara, INDEPENDIENTES de la máquina
 * de la selfie:
 *  - `starting`: vista montada, esperando a que la cámara quede lista (`onCameraReady`).
 *  - `ready`: cámara lista; habilita el botón "Tomar foto".
 *  - `permission`: permiso de cámara denegado (`E_CAMERA_PERMISSION`) → CTA "Abrir Ajustes".
 *  - `device`: cualquier otro fallo de hardware/config/cámara frontal → mensaje genérico con reintento.
 */
type CameraState = 'starting' | 'ready' | 'permission' | 'device';

/** El único código nativo que mapeamos a "permiso"; el resto cae en error de dispositivo. */
const PERMISSION_ERROR_CODE: BiometricCameraErrorCode = 'E_CAMERA_PERMISSION';

const PREVIEW = 240;

/** Marca de éxito (check) con micro-interacción de aparición. Reemplaza la preview de la cámara. */
function SuccessCheck(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.previewWrap}>
      <View
        style={[
          styles.disc,
          {
            backgroundColor: hexAlpha(theme.colors.success, 0.16),
            borderColor: theme.colors.success,
          },
        ]}
      >
        <IconCheck size={64} color={theme.colors.success} strokeWidth={2.4} />
      </View>
    </View>
  );
}

/**
 * Cámara frontal EN VIVO (vista nativa `BiometricCameraPreview`) recortada en círculo. La preview se
 * espeja (selfie natural) pero el archivo capturado NO. La cámara solo está activa mientras la pantalla
 * está enfocada Y el flujo está en `idle` (encuadrando): al confirmar/salir se desmonta para LIBERAR el
 * sensor frontal (no debe quedar abierto y chocar con el WebRTC del viaje o el gate de turno).
 */
function LiveFacePreview({
  onReady,
  onError,
}: {
  onReady: () => void;
  onError: (payload: BiometricCameraErrorPayload) => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.previewWrap}>
      <View
        style={[
          styles.circle,
          // Anillo azul BRILLANTE + grueso (fidelidad al frame `C/IdentityVerif`, donde el ring es prominente).
          { borderColor: theme.colors.accent, backgroundColor: theme.colors.bg },
        ]}
      >
        <BiometricCameraPreview
          style={StyleSheet.absoluteFill}
          mirrored
          onCameraReady={onReady}
          onCameraError={(event) => onError(event.nativeEvent)}
        />
      </View>
    </View>
  );
}

/** Paso 3 del alta: verificación de identidad con UNA SELFIE simple (cámara → foto → preview → enroll). */
// El back ya no usa el prop `navigation` (lo maneja `useRegistrationStepBack`); el tipo `Props` se
// mantiene para documentar que es la pantalla del paso `IdentityVerification`.
export const IdentityVerificationScreen = (_props: Props = {}): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const {
    phase,
    error,
    errorSource,
    enrollErrorKind,
    isIdle,
    isCapturing,
    isPreview,
    isSubmitting,
    isSuccess,
    isFailed,
    capture,
    confirm,
    retake,
    retry,
  } = useRegistrationFaceCapture();

  // Modo dual + FOCO de cámara: embebido en el pager (publica su footer al host y la cámara se activa SOLO
  // cuando esta página está visible, para LIBERAR el sensor frontal en los pasos 1-2) o standalone (chrome
  // propio). `isActive` = la página del KYC es la que el pager muestra.
  const wizard = useRegistrationWizardPageOptional();
  const pageIndex = ORDERED_STEPS.indexOf(RegistrationStep.IDENTITY_VERIFICATION);
  const isActive = wizard ? wizard.index === pageIndex : true;

  // Estado de la cámara (HONESTO: iniciando / lista / permiso denegado / error de dispositivo).
  const [cameraState, setCameraState] = useState<CameraState>('starting');

  const handleCameraReady = useCallback(() => {
    setCameraState('ready');
  }, []);

  // Mapeo TIPADO del código nativo → estado de UI (sin comparar strings sueltos): solo el permiso tiene
  // su CTA propio (Ajustes); cualquier otro código es error de dispositivo (mensaje genérico con reintento).
  const handleCameraError = useCallback((payload: BiometricCameraErrorPayload) => {
    setCameraState(payload.code === PERMISSION_ERROR_CODE ? 'permission' : 'device');
  }, []);

  // Reintentar tras un fallo de cámara: volvemos a "iniciando" para forzar un nuevo ciclo de eventos.
  const retryCamera = useCallback(() => {
    setCameraState('starting');
  }, []);

  // Al volver a `idle` (retake/retry) reseteamos la cámara para re-montar la preview en vivo.
  useEffect(() => {
    if (isIdle) {
      setCameraState('starting');
    }
  }, [isIdle]);

  const openSettings = useCallback(() => {
    void Linking.openSettings();
  }, []);

  // Back robusto del paso (solo standalone): embebido lo maneja el host del wizard.
  const back = useRegistrationStepBack(!wizard);

  // La preview en vivo se muestra mientras se encuadra (idle) o se dispara la captura (capturing) Y la página
  // está VISIBLE (`isActive`): en los pasos 1-2 del pager el KYC sigue montado pero la cámara NO arranca, así
  // el sensor frontal queda libre hasta que el conductor llega a este paso.
  const showLivePreview = (isIdle || isCapturing) && isActive;
  const cameraReady = cameraState === 'ready';
  // El botón "Tomar foto" solo se habilita con la cámara lista y sin trabajo en curso.
  const canTake = isIdle && cameraReady;

  // Error de "módulo nativo no disponible" durante la captura: banner informativo (no de cámara).
  const errorCode = error instanceof Error ? (error as { code?: string }).code : undefined;
  const unavailable = errorSource === 'capture' && errorCode === FACE_PHOTO_GRABBER_UNAVAILABLE;

  // Subtítulo: en preview, "¿Se ve bien?"; encuadrando, el genérico.
  const subtitle = isPreview
    ? t('registration.kyc.previewSubtitle')
    : t('registration.kyc.subtitle');

  // EMBEBIDO: publica el footer del KYC al host, ADAPTADO a la fase (el KYC no tiene un "Continuar" plano):
  //  · idle    → "Tomar foto" (+ hint si la cámara arranca).
  //  · preview → "Confirmar" (primary) + "Volver a tomar" (secundaria, reemplaza al Atrás).
  //  · failed  → sin primary; queda el "Atrás" del host (el reintento vive en el banner de estado).
  //  · capturing/submitting/success → SIN footer (el cuerpo muestra el estado).
  // Refs estables a las acciones para no re-registrar en cada render (el footer solo cambia con la fase).
  const captureRef = useRef(capture);
  captureRef.current = capture;
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  const retakeRef = useRef(retake);
  retakeRef.current = retake;
  useEffect(() => {
    if (!wizard) {
      return;
    }
    let footer: WizardPageFooter | null;
    if (isIdle) {
      footer = {
        primaryLabel: t('registration.kyc.takePhoto'),
        onPrimary: () => void captureRef.current(),
        primaryDisabled: !canTake,
        hint: cameraReady ? undefined : t('registration.kyc.startingCamera'),
      };
    } else if (isPreview) {
      footer = {
        primaryLabel: t('registration.actions.usePhoto'),
        onPrimary: () => void confirmRef.current(),
        secondaryLabel: t('registration.actions.retake'),
        onSecondary: () => retakeRef.current(),
      };
    } else if (isFailed) {
      footer = { primaryLabel: '', onPrimary: () => undefined, primaryHidden: true };
    } else {
      footer = null; // capturing / submitting / success
    }
    wizard.registerFooter(pageIndex, footer);
    return () => wizard.registerFooter(pageIndex, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizard, pageIndex, isIdle, isPreview, isFailed, canTake, cameraReady]);

  // CUERPO del paso (compartido por ambos modos). En embebido el chrome (header/progress/footer/exit) y el
  // CTA unificado los pone el host; acá NO se pintan el progress ni los botones de acción (van al footer).
  const stepBody = (
    <View style={[styles.body, { gap: theme.spacing['2xl'] }]}>
      {wizard ? null : (
        <Reveal>
          <RegistrationProgress current={RegistrationStep.IDENTITY_VERIFICATION} />
        </Reveal>
      )}

      {/* Bloque héroe CENTRADO (fidelidad al frame `C/IdentityVerif`: `alignItems: center`, distinto del
          left-align de Onboarding/Login — este paso es simétrico alrededor del círculo de la cámara).
          Título `display` 28/700 + subtítulo muted, ambos centrados. */}
      <Reveal delay={40} style={styles.intro}>
        <Text variant="title1" align="center">
          {t('registration.kyc.title')}
        </Text>
        <Text variant="callout" color="inkMuted" align="center">
          {subtitle}
        </Text>
      </Reveal>

      {/* Zona del círculo: cambia por fase, sin perder el centro. */}
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
      ) : isPreview ? (
        // Preview: la selfie quedó tomada. Anillo de éxito limpio (el subtítulo "¿Se ve bien?" ya da el
        // contexto, sin el rótulo "Capturado ✓" redundante). El conductor confirma o vuelve a tomar (footer).
        <Reveal spring style={styles.ringArea}>
          <View style={styles.previewWrap}>
            <View style={[styles.disc, { borderColor: theme.colors.success }]}>
              <IconCheck size={64} color={theme.colors.success} strokeWidth={2.4} />
            </View>
          </View>
        </Reveal>
      ) : (
        <Reveal delay={120} spring style={styles.ringArea}>
          {showLivePreview ? (
            <LiveFacePreview onReady={handleCameraReady} onError={handleCameraError} />
          ) : (
            <View style={styles.previewWrap}>
              <ActivityIndicator size="large" color={theme.colors.accent} />
            </View>
          )}
        </Reveal>
      )}

      {renderStatus({
        t,
        theme,
        unavailable,
        cameraState,
        phase,
        enrollErrorKind: errorSource === 'enroll' ? enrollErrorKind : null,
        isFailed,
        onOpenSettings: openSettings,
        onRetryCamera: retryCamera,
        onRetry: retry,
      })}

      <View style={styles.spacer} />

      {/* "Capturando…" es un ESTADO (no un botón): se muestra en ambos modos. Los BOTONES de acción
          (Tomar foto / Volver a tomar / Confirmar) SOLO en standalone; embebido los pinta el footer del host. */}
      {isCapturing ? (
        <Reveal style={styles.ctaWrap}>
          <Text variant="bodyStrong" color="accent" align="center">
            {t('registration.kyc.capturing')}
          </Text>
        </Reveal>
      ) : null}

      {!wizard && isIdle ? (
        <Reveal delay={200} style={styles.ctaWrap}>
          <Button
            label={t('registration.kyc.takePhoto')}
            onPress={() => void capture()}
            disabled={!canTake}
            fullWidth
          />
          {!cameraReady ? (
            <Text variant="footnote" color="inkMuted" align="center" style={styles.hint}>
              {t('registration.kyc.startingCamera')}
            </Text>
          ) : null}
        </Reveal>
      ) : null}

      {!wizard && isPreview ? (
        <Reveal delay={120} style={[styles.ctaWrap, styles.previewActions]}>
          <Button
            label={t('registration.actions.retake')}
            variant="ghost"
            onPress={retake}
            style={styles.previewBtn}
          />
          <Button
            label={t('registration.actions.usePhoto')}
            onPress={() => void confirm()}
            style={styles.previewBtn}
          />
        </Reveal>
      ) : null}
    </View>
  );

  // Modo EMBEBIDO (wizard): solo el cuerpo (flex), con su padding horizontal (el host es `padded={false}`).
  if (wizard) {
    return <View style={styles.embeddedBody}>{stepBody}</View>;
  }

  // Modo STANDALONE (fuera del wizard, p. ej. tests): chrome propio + exit sheet.
  return (
    <>
      <SafeScreen header={<RegistrationHeader showLogo onBack={back.onBack} peruRight />}>
        {stepBody}
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
  phase: SelfiePhase;
  enrollErrorKind: ReturnType<typeof useRegistrationFaceCapture>['enrollErrorKind'];
  isFailed: boolean;
  onOpenSettings: () => void;
  onRetryCamera: () => void;
  onRetry: () => void;
}

/**
 * Banda de estado bajo el círculo. Prioridad:
 *  éxito → módulo no disponible → fallo de enroll (rostro/red/incompleto/genérico) con "Intentar de nuevo"
 *  → permiso de cámara → error de dispositivo de cámara → privacidad.
 * Cada caso es un banner/aviso DISTINTO y accionable.
 */
function renderStatus({
  t,
  theme,
  unavailable,
  cameraState,
  phase,
  enrollErrorKind,
  isFailed,
  onOpenSettings,
  onRetryCamera,
  onRetry,
}: StatusArgs): React.JSX.Element | null {
  if (phase === SelfiePhase.SUCCESS) {
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

  if (phase === SelfiePhase.SUBMITTING) {
    return (
      <Reveal>
        <Text variant="callout" color="inkMuted" align="center">
          {t('registration.kyc.submitting')}
        </Text>
      </Reveal>
    );
  }

  // Módulo nativo de cámara no enlazado durante la captura: banner informativo con reintento.
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

  // Errores del backend al confirmar (enroll). El reintento vuelve a tomar la foto.
  if (isFailed && enrollErrorKind) {
    if (enrollErrorKind === 'missing-capture') {
      return (
        <Reveal>
          <Banner
            tone="warn"
            title={t('registration.kyc.enrollMissingCaptureTitle')}
            description={t('registration.kyc.enrollMissingCaptureBody')}
            action={{ label: t('registration.kyc.tryAgain'), onPress: onRetry }}
          />
        </Reveal>
      );
    }
    if (enrollErrorKind === 'spoof') {
      // Anti-spoofing pasivo: la cámara apuntó a una foto/pantalla, no a una persona real. Tono `danger`
      // (es un rechazo de seguridad, no un "mejorá la luz") con instrucción específica.
      return (
        <Reveal>
          <Banner
            tone="danger"
            title={t('registration.kyc.enrollSpoofTitle')}
            description={t('registration.kyc.enrollSpoofBody')}
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

  // Fallo de captura sin código de "no disponible" (timeout, hardware): banner genérico con reintento.
  if (isFailed) {
    return (
      <Reveal>
        <Banner
          tone="danger"
          title={t('registration.kyc.cameraErrorTitle')}
          description={t('registration.kyc.cameraErrorBody')}
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
          action={{ label: t('registration.actions.retryCamera'), onPress: onRetryCamera }}
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
  // Embebido: el host del wizard es `padded={false}`; la página aporta su padding horizontal y llena el alto.
  embeddedBody: { flex: 1, paddingHorizontal: 20 },
  body: { flex: 1, paddingTop: 20 },
  // Bloque héroe CENTRADO (fidelidad al frame): título + subtítulo centrados alrededor del círculo.
  intro: { gap: 10, marginTop: 12, alignItems: 'center' },
  ringArea: {
    height: PREVIEW + 20,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    width: '100%',
  },
  previewWrap: { width: PREVIEW, height: PREVIEW, alignItems: 'center', justifyContent: 'center' },
  // El video/placeholder se recorta en círculo para encajar con la estética. El fondo (mientras la
  // cámara arranca) lo aporta el tema inline (`theme.colors.bg`), no un negro suelto: tokenizado.
  circle: {
    width: PREVIEW,
    height: PREVIEW,
    borderRadius: PREVIEW / 2,
    borderWidth: 3,
    overflow: 'hidden',
  },
  disc: {
    width: PREVIEW,
    height: PREVIEW,
    borderRadius: PREVIEW / 2,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  capturedLabel: { paddingHorizontal: 16 },
  privacy: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  privacyText: { flexShrink: 1 },
  spacer: { flex: 1 },
  ctaWrap: { paddingBottom: 8, gap: 8 },
  hint: { paddingTop: 2 },
  previewActions: { flexDirection: 'row', gap: 12 },
  previewBtn: { flex: 1 },
});
