import { useCallback, useMemo, useRef, useState } from 'react';
import { useFaceCapture } from '../providers/FaceCaptureProvider';
import {
  classifyKycEnrollError,
  MissingFaceCaptureError,
  type KycEnrollErrorKind,
} from '../kycEnrollError';
import { useRegistrationSubmit } from './useRegistrationSubmit';
import { useEnrollBiometric } from './useRegistrationDocuments';

/**
 * Fases del flujo de KYC del alta con UNA SELFIE SIMPLE (estado de PRESENTACIÓN, no de negocio). Reemplaza
 * la vieja máquina de LIVENESS reactivo (reto → frames → enroll) por la captura de una sola foto frontal:
 *  - `idle`: cámara lista; la pantalla muestra la preview en vivo y espera el toque de "Tomar foto".
 *  - `capturing`: disparando la captura nativa de la foto (la cámara entrega UNA foto JPEG base64).
 *  - `preview`: foto capturada; la pantalla pregunta "¿Se ve bien?" (retomar / confirmar).
 *  - `submitting`: enrolando `{ photo }` (`POST /drivers/biometric/enroll`) y cerrando el alta (`submit`).
 *  - `success`: enroló + cerró; el `RootNavigator` conmuta de pantalla (server-driven).
 *  - `failed`: error (captura / enroll 422 rostro / red / genérico). La pantalla muestra un banner humano y
 *    el reintento vuelve a `idle` para tomar otra foto.
 */
export type SelfiePhase = 'idle' | 'capturing' | 'preview' | 'submitting' | 'success' | 'failed';

/**
 * Valores CANÓNICOS de la fase de la selfie (mismo patrón que `RegistrationStatus`): conmutar el estado
 * SIN strings mágicos. El `satisfies` garantiza que cada valor pertenece al union — un typo es un ERROR
 * DE COMPILACIÓN, no un bug mudo.
 */
export const SelfiePhase = {
  IDLE: 'idle',
  CAPTURING: 'capturing',
  PREVIEW: 'preview',
  SUBMITTING: 'submitting',
  SUCCESS: 'success',
  FAILED: 'failed',
} as const satisfies Record<string, SelfiePhase>;

/**
 * Origen del último error, para que la presentación elija el mensaje correcto sin re-inspeccionar el error:
 *  - `capture`: falló capturar la foto (módulo nativo no disponible, permiso, timeout de cámara).
 *  - `enroll`: falló confirmar (enroll/submit); aquí aplica el mapeo rostro/red/incompleto/genérico.
 */
export type SelfieErrorSource = 'capture' | 'enroll';

/**
 * Orquesta el KYC de UNA SELFIE del alta: la PANTALLA es dueña de la máquina de estados; este hook la
 * implementa sobre IO inyectado:
 *  - captura: `useFaceCapture().captureForRegistration()` (cámara frontal nativa → 1 foto base64),
 *  - enroll + cierre: `useEnrollBiometric` (`POST /drivers/biometric/enroll`, `{ photo }`) → `useRegistrationSubmit`.
 *
 * SEGURIDAD (defense-in-depth): el enroll es REQUISITO para cerrar el alta — `submit` solo corre si el
 * enroll resolvió. Sin una foto real NO se llama al enroll (`MissingFaceCaptureError`). La guarda
 * anti-reentrada (`runningRef`) garantiza que un doble toque del CTA no dispare la secuencia dos veces.
 */
export function useRegistrationFaceCapture() {
  const faceCapture = useFaceCapture();
  const enroll = useEnrollBiometric();
  const submit = useRegistrationSubmit();

  // Fase de UI. Arranca en `idle` (cámara montándose; la pantalla muestra la preview en vivo).
  const [phase, setPhase] = useState<SelfiePhase>(SelfiePhase.IDLE);
  // Foto capturada (base64 JPEG sin prefijo `data:`) a la espera de confirmación. `null` fuera de `preview`.
  const [photo, setPhoto] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [errorSource, setErrorSource] = useState<SelfieErrorSource | null>(null);
  // Guarda anti-reentrada: la fase se actualiza async, así que un doble toque rápido entraría dos veces
  // antes del re-render. El ref se marca SÍNCRONO para garantizar que captura/confirmación corran una vez.
  const runningRef = useRef(false);

  /**
   * Toma UNA foto frontal con la cámara nativa. No enrola todavía: deja la foto en `preview` para que el
   * conductor la revise (retomar / confirmar). Un fallo de captura (módulo no disponible, permiso, timeout)
   * pasa la fase a `failed` con `source: 'capture'`.
   */
  const capture = useCallback(async () => {
    if (runningRef.current) {
      return;
    }
    runningRef.current = true;
    setError(null);
    setErrorSource(null);
    setPhase(SelfiePhase.CAPTURING);
    try {
      const result = await faceCapture.captureForRegistration();
      if (!result.photoBase64) {
        // El proveedor no entregó una foto real (p. ej. stub de desarrollo). NO seguimos sin imagen.
        throw new MissingFaceCaptureError();
      }
      setPhoto(result.photoBase64);
      setPhase(SelfiePhase.PREVIEW);
    } catch (e) {
      setError(e);
      setErrorSource('capture');
      setPhase(SelfiePhase.FAILED);
    } finally {
      runningRef.current = false;
    }
  }, [faceCapture]);

  /**
   * Confirma la foto en preview: enrola `{ photo }` (OBLIGATORIO) y, solo si resolvió, cierra el alta
   * (server-driven). El enroll es prerequisito del cierre: si falla, `submit` NO corre y la fase pasa a
   * `failed` con `source: 'enroll'` (mapeo rostro/red/incompleto/genérico).
   */
  const confirm = useCallback(async () => {
    if (runningRef.current || photo == null) {
      return;
    }
    runningRef.current = true;
    setError(null);
    setErrorSource(null);
    setPhase(SelfiePhase.SUBMITTING);
    try {
      await enroll.mutateAsync({ photo });
      await submit.mutateAsync();
      setPhase(SelfiePhase.SUCCESS);
    } catch (e) {
      runningRef.current = false;
      setError(e);
      setErrorSource('enroll');
      setPhase(SelfiePhase.FAILED);
      return;
    }
    runningRef.current = false;
  }, [photo, enroll, submit]);

  /**
   * Descarta la foto en preview y vuelve a `idle` para tomar otra (CTA "Volver a tomar"). No toca el
   * backend: es puramente local.
   */
  const retake = useCallback(() => {
    runningRef.current = false;
    setPhoto(null);
    setError(null);
    setErrorSource(null);
    setPhase(SelfiePhase.IDLE);
  }, []);

  /**
   * Reintenta tras un fallo. Descarta la foto consumida y vuelve a `idle` para reiniciar la captura desde
   * la cámara en vivo (no reusa una foto que pudo fallar el enroll).
   */
  const retry = useCallback(() => {
    runningRef.current = false;
    setPhoto(null);
    setError(null);
    setErrorSource(null);
    setPhase(SelfiePhase.IDLE);
  }, []);

  /**
   * Clasificación del error de CONFIRMAR (rostro / red / incompleto / genérico) para que la pantalla muestre
   * el mensaje específico. Solo aplica cuando el error vino del enroll; ante un error de captura es `null`
   * (ese caso lo cubre el banner de cámara con su propio reintento).
   */
  const enrollErrorKind: KycEnrollErrorKind | null = useMemo(
    () => (error && errorSource === 'enroll' ? classifyKycEnrollError(error) : null),
    [error, errorSource],
  );

  return {
    phase,
    photo,
    error,
    errorSource,
    enrollErrorKind,
    isIdle: phase === SelfiePhase.IDLE,
    isCapturing: phase === SelfiePhase.CAPTURING,
    isPreview: phase === SelfiePhase.PREVIEW,
    isSubmitting: phase === SelfiePhase.SUBMITTING,
    isSuccess: phase === SelfiePhase.SUCCESS,
    isFailed: phase === SelfiePhase.FAILED,
    capture,
    confirm,
    retake,
    retry,
  };
}
