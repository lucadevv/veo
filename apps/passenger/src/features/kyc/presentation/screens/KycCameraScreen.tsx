import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@veo/api-client';
import { Banner, Button, SafeScreen, StatusPill, Text, useTheme } from '@veo/ui-kit';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native';
import {
  useCameraDevice,
  useCameraFormat,
  useCameraPermission,
} from 'react-native-vision-camera';
import type { Camera as VisionCamera } from 'react-native-vision-camera';
import { Camera as FaceCamera, type Face } from 'react-native-vision-camera-face-detector';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import type { RootStackParamList } from '../../../../navigation/types';
import type { KycChallenge, KycStatus } from '../../domain/entities';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Umbrales de detección (grados de ángulo de cabeza · probabilidad de ojo). Tolerantes a propósito:
 *  el veredicto real lo decide el servidor; on-device es SOLO guía + autocaptura (no debe trabar). */
const CENTER_YAW = 16;
const CENTER_PITCH = 16;
const MOVE_YAW = 20;
const MOVE_PITCH = 16;
const BLINK_CLOSED = 0.25;

/** Fases locales del flujo de captura con detección en vivo. */
type Phase = 'requesting' | 'detecting' | 'ready' | 'capturing' | 'submitting' | 'resolved';

const RESULT_TONE: Record<KycStatus, 'success' | 'warn' | 'danger' | 'neutral'> = {
  approved: 'success',
  pending: 'warn',
  rejected: 'danger',
  unverified: 'neutral',
};

/** Lee un archivo local como base64 (sin prefijo data:) usando fetch+FileReader, sin dependencias nativas extra. */
async function fileToBase64(uri: string): Promise<string> {
  const res = await fetch(uri);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('file-read'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Verificación de identidad (KYC) con DETECCIÓN FACIAL EN VIVO (VisionCamera + MLKit).
 *
 * On-device = guía + autocaptura: detecta el rostro (recuadro), confirma encuadre frontal, pide el
 * movimiento del reto (girar la cabeza / parpadear) y, al detectarlo, captura un frame y lo envía.
 * El VEREDICTO de liveness lo decide SIEMPRE el servidor (biometric self-hosted) — nunca el cliente.
 *
 * La cámara se libera al salir de la pantalla (`isActive` ligado a `useIsFocused`) para no chocar con
 * el WebRTC del viaje (ownership secuencial de la cámara).
 */
export function KycCameraScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const isFocused = useIsFocused();

  const requestKycChallenge = useDependency(TOKENS.requestKycChallengeUseCase);
  const submitKyc = useDependency(TOKENS.submitKycUseCase);
  const queryClient = useQueryClient();

  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('front');
  // Formato de foto moderado (no full-res) para que el JPEG base64 viaje liviano al bff.
  const format = useCameraFormat(device, [{ photoResolution: { width: 1280, height: 720 } }]);
  const cameraRef = useRef<VisionCamera>(null);

  const [phase, setPhaseState] = useState<Phase>('requesting');
  const phaseRef = useRef<Phase>('requesting');
  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const [challenge, setChallenge] = useState<KycChallenge | null>(null);
  // Acción del reto en un ref: la lee el callback de detección (que corre por frame) sin re-crearse.
  const actionRef = useRef<string | null>(null);
  const [faceCentered, setFaceCentered] = useState(false);
  const centeredRef = useRef(false);
  const [result, setResult] = useState<KycStatus | null>(null);
  const [rejectionReason, setRejectionReason] = useState<string | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reto de liveness (acción + instrucción a mostrar). Al resolver, pasamos a detectar el rostro.
  const challengeMutation = useMutation({
    mutationFn: () => requestKycChallenge.execute(),
    onSuccess: (next) => {
      if (!mountedRef.current) return;
      setChallenge(next);
      actionRef.current = next.action;
      setPhase('detecting');
    },
  });

  // Envío de la verificación: 1 frame capturado tras detectar el movimiento.
  const submitMutation = useMutation<KycStatus, Error, string>({
    mutationFn: async (base64Jpeg) => {
      if (!challenge) throw new Error('no-challenge');
      const outcome = await submitKyc.execute(challenge.challengeId, [
        { base64Jpeg, capturedAt: Date.now() },
      ]);
      return outcome.status === 'rejected'
        ? (setRejectionReason(outcome.reason), 'rejected')
        : outcome.status;
    },
    onSuccess: (status) => {
      if (!mountedRef.current) return;
      setResult(status);
      setPhase('resolved');
      // El kycStatus del servidor cambió → invalidamos el perfil para que Profile (y cualquier vista
      // que lo lea) reflejen VERIFIED y desaparezca el aviso "verificar identidad". `['profile']` cubre
      // por prefijo a `['profile','me']`.
      void queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
    onError: () => {
      if (!mountedRef.current) return;
      // Vuelve a detectar para reintentar (la cámara sigue activa).
      setPhase('ready');
    },
  });

  // Pide permiso al montar y, si hay, arranca el reto.
  useEffect(() => {
    let active = true;
    void (async () => {
      const granted = hasPermission || (await requestPermission());
      if (active && granted) {
        challengeMutation.mutate();
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Captura un frame y lo envía (autocaptura tras detectar el movimiento del reto).
  const capture = useCallback(async () => {
    try {
      const photo = await cameraRef.current?.takePhoto({
        flash: 'off',
        enableShutterSound: false,
      });
      if (!photo) throw new Error('no-photo');
      const base64 = await fileToBase64(`file://${photo.path}`);
      if (!mountedRef.current) return;
      setPhase('submitting');
      submitMutation.mutate(base64);
    } catch {
      if (mountedRef.current) setPhase('ready');
    }
  }, [setPhase, submitMutation]);

  // Callback de detección facial (corre por frame). Mantenemos el estado en refs y sólo disparamos
  // re-render / transición cuando cambia algo relevante, para no re-renderizar a 30fps.
  const onFaces = useCallback(
    (faces: Face[]) => {
      const face = faces[0];
      const centered =
        !!face && Math.abs(face.yawAngle) < CENTER_YAW && Math.abs(face.pitchAngle) < CENTER_PITCH;
      if (centered !== centeredRef.current) {
        centeredRef.current = centered;
        setFaceCentered(centered);
      }
      if (!face) return;

      if (phaseRef.current === 'detecting' && centered) {
        setPhase('ready');
        return;
      }
      if (phaseRef.current === 'ready') {
        const moved = Math.abs(face.yawAngle) > MOVE_YAW || Math.abs(face.pitchAngle) > MOVE_PITCH;
        const blinked =
          face.leftEyeOpenProbability < BLINK_CLOSED && face.rightEyeOpenProbability < BLINK_CLOSED;
        // Exigimos el gesto que PIDIÓ el server (challenge.action), no cualquiera. Si la acción es
        // desconocida, aceptamos cualquier gesto (fallback degradado, no traba al usuario).
        const action = (actionRef.current ?? '').toUpperCase();
        const wantsBlink = action.includes('BLINK') || action.includes('EYE');
        const wantsTurn =
          action.includes('TURN') ||
          action.includes('HEAD') ||
          action.includes('LEFT') ||
          action.includes('RIGHT') ||
          action.includes('NOD');
        const satisfied =
          wantsBlink && !wantsTurn ? blinked : wantsTurn && !wantsBlink ? moved : moved || blinked;
        if (satisfied) {
          setPhase('capturing');
          void capture();
        }
      }
    },
    [capture, setPhase],
  );

  const cameraActive =
    isFocused && (phase === 'detecting' || phase === 'ready' || phase === 'capturing');

  // ── Resultado ────────────────────────────────────────────────────────────
  if (phase === 'resolved' && result) {
    const titleKey =
      result === 'approved'
        ? 'kyc.resultApprovedTitle'
        : result === 'pending'
          ? 'kyc.resultPendingTitle'
          : 'kyc.resultRejectedTitle';
    const bodyKey =
      result === 'approved'
        ? 'kyc.resultApprovedBody'
        : result === 'pending'
          ? 'kyc.resultPendingBody'
          : 'kyc.resultRejectedBody';
    return (
      <SafeScreen
        footer={
          result === 'rejected' ? (
            // Rechazado: además de reintentar, SIEMPRE una salida (antes solo había "Reintentar" → el
            // usuario quedaba atrapado en el loop sin poder volver al perfil).
            <View style={{ gap: 8 }}>
              <Button
                label={t('kyc.retry')}
                fullWidth
                onPress={() => {
                  setResult(null);
                  setRejectionReason(undefined);
                  setChallenge(null);
                  centeredRef.current = false;
                  setFaceCentered(false);
                  setPhase('requesting');
                  challengeMutation.reset();
                  submitMutation.reset();
                  challengeMutation.mutate();
                }}
              />
              <Button
                label={t('actions.close')}
                variant="ghost"
                fullWidth
                onPress={() => navigation.goBack()}
              />
            </View>
          ) : (
            <Button label={t('actions.close')} fullWidth onPress={() => navigation.goBack()} />
          )
        }
      >
        <View style={styles.resultBody}>
          <StatusPill label={t('kyc.kycLabel')} tone={RESULT_TONE[result]} dot />
          <Text variant="title2" align="center">
            {t(titleKey)}
          </Text>
          <Text variant="callout" color="inkMuted" align="center">
            {t(bodyKey)}
          </Text>
          {result === 'rejected' && rejectionReason ? (
            <Banner tone="warn" title={t('kyc.rejectionReason')} description={rejectionReason} />
          ) : null}
        </View>
      </SafeScreen>
    );
  }

  // Texto guía según fase + estado de detección.
  const guide =
    phase === 'requesting'
      ? t('kyc.preparingChallenge')
      : phase === 'submitting'
        ? t('kyc.submitting')
        : phase === 'capturing'
          ? t('kyc.holdStill')
          : phase === 'ready'
            ? (challenge?.instructions ?? t('kyc.livenessHint'))
            : faceCentered
              ? t('kyc.faceDetected')
              : t('kyc.centerFace');

  const ovalColor =
    phase === 'ready' || phase === 'capturing'
      ? theme.colors.accent
      : faceCentered
        ? theme.colors.success
        : theme.colors.surface;

  // ── Sin permiso / sin cámara ─────────────────────────────────────────────
  if (!device) {
    return (
      <SafeScreen footer={<Button label={t('actions.close')} fullWidth onPress={() => navigation.goBack()} />}>
        <View style={styles.resultBody}>
          <Banner tone="danger" title={t('kyc.captureUnavailableTitle')} description={t('kyc.noFrontCamera')} />
        </View>
      </SafeScreen>
    );
  }

  // ── Cámara + detección en vivo ─────────────────────────────────────────────
  return (
    <SafeScreen padded={false}>
      <View style={styles.fill}>
        <View style={[styles.preview, { backgroundColor: theme.colors.ink }]}>
          {hasPermission ? (
            <FaceCamera
              ref={cameraRef}
              style={StyleSheet.absoluteFill}
              device={device}
              format={format}
              isActive={cameraActive}
              photo
              faceDetectionOptions={{
                performanceMode: 'fast',
                classificationMode: 'all',
                landmarkMode: 'none',
                contourMode: 'none',
                minFaceSize: 0.2,
              }}
              faceDetectionCallback={onFaces}
            />
          ) : null}

          {/* Óvalo guía que reacciona a la detección: gris (sin rostro) → verde (encuadrado) → lima (reto). */}
          <View pointerEvents="none" style={styles.overlay}>
            <View style={[styles.faceGuide, { borderColor: ovalColor }]} />
          </View>

          {/* Indicador de captura visible (privacidad). */}
          {cameraActive ? (
            <View style={[styles.recBadge, { top: theme.spacing.lg, left: theme.spacing.lg }]}>
              <StatusPill
                label={faceCentered ? t('kyc.faceDetected') : t('kyc.capturing')}
                tone={faceCentered ? 'success' : 'danger'}
                live
                dot
              />
            </View>
          ) : null}

          {/* Guía/instrucción prominente sobre la cámara. */}
          <View
            pointerEvents="none"
            style={[
              styles.challengeBanner,
              {
                bottom: theme.spacing.xl,
                left: theme.spacing.lg,
                right: theme.spacing.lg,
                padding: theme.spacing.md,
                gap: theme.spacing.xs,
                borderRadius: theme.radii.lg,
                backgroundColor: theme.colors.overlay,
              },
            ]}
          >
            {phase === 'ready' ? (
              <Text variant="footnote" color="surface" align="center">
                {t('kyc.followInstruction')}
              </Text>
            ) : null}
            <Text variant="title3" color="surface" align="center">
              {guide}
            </Text>
          </View>
        </View>

        {/* Panel inferior. */}
        <View style={[styles.panel, { padding: theme.spacing.xl, gap: theme.spacing.md, backgroundColor: theme.colors.surface }]}>
          <Text variant="title3">{t('kyc.title')}</Text>
          <Text variant="callout" color="inkMuted">
            {t('kyc.subtitle')}
          </Text>

          {challengeMutation.isError ? (
            <Banner
              tone="danger"
              title={t('kyc.challengeErrorTitle')}
              description={
                challengeMutation.error instanceof ApiError && challengeMutation.error.status === 404
                  ? t('kyc.submitErrorPending')
                  : t('kyc.challengeErrorBody')
              }
            />
          ) : null}

          {submitMutation.isError ? (
            <Banner
              tone="danger"
              title={t('kyc.submitErrorTitle')}
              description={
                submitMutation.error instanceof ApiError && submitMutation.error.status === 404
                  ? t('kyc.submitErrorPending')
                  : t('kyc.submitErrorBody')
              }
            />
          ) : null}

          {!hasPermission ? (
            <Banner
              tone="warn"
              title={t('kyc.permissionBlockedTitle')}
              description={t('kyc.permissionBlockedBody')}
              action={{ label: t('kyc.openSettings'), onPress: () => void Linking.openSettings() }}
            />
          ) : null}

          {phase === 'requesting' || phase === 'submitting' ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={theme.colors.accent} />
              <Text variant="footnote" color="inkMuted" style={{ marginTop: theme.spacing.sm }}>
                {phase === 'requesting' ? t('kyc.preparingChallenge') : t('kyc.submitting')}
              </Text>
            </View>
          ) : null}

          <Button label={t('actions.cancel')} variant="ghost" fullWidth onPress={() => navigation.goBack()} />
        </View>
      </View>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill },
  preview: { flex: 1, overflow: 'hidden' },
  overlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  faceGuide: { width: '70%', aspectRatio: 0.78, borderWidth: 3, borderRadius: 9999, opacity: 0.9 },
  recBadge: { position: 'absolute' },
  challengeBanner: { position: 'absolute' },
  panel: {},
  resultBody: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, paddingHorizontal: 24 },
  loadingRow: { alignItems: 'center', paddingVertical: 8 },
});
