import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LivenessAction } from '@veo/shared-types';
import { planForChallenge } from '../../domain';
import { useLivenessGrabber } from '../providers/LivenessCaptureProvider';
import { classifyKycEnrollError, type KycEnrollErrorKind } from '../kycEnrollError';
import { useRegistrationSubmit } from './useRegistrationSubmit';
import { useEnrollBiometric, useLivenessChallenge } from './useRegistrationDocuments';

/**
 * Fases del flujo de KYC del alta con LIVENESS REACTIVO (estado de PRESENTACIÓN, no de negocio). Reemplaza
 * el viejo `idle|capturing|preview|submitting` (foto única) por la máquina del reto activo estilo banca:
 *  - `requesting-challenge`: pidiendo el reto al servidor (`GET …/liveness/challenge`).
 *  - `ready`: reto recibido; la pantalla muestra el prompt + el cue direccional y espera que el conductor
 *    inicie el gesto.
 *  - `performing`: capturando frames mientras el conductor ejecuta el gesto (progreso real 0..1).
 *  - `submitting`: enrolando `{ challengeId, frames }` y cerrando el alta.
 *  - `success`: enroló + cerró; el `RootNavigator` conmuta de pantalla (server-driven).
 *  - `failed`: error (reto / captura / enroll / liveness 422 / red). La pantalla muestra un banner humano y
 *    el reintento pide un reto NUEVO (los retos son de un solo uso).
 */
export type LivenessPhase =
  | 'requesting-challenge'
  | 'ready'
  | 'performing'
  | 'submitting'
  | 'success'
  | 'failed';

/**
 * Valores CANÓNICOS de la fase del liveness (mismo patrón que `RegistrationStatus`): conmutar el estado
 * SIN strings mágicos. El `satisfies` garantiza que cada valor pertenece al union — un typo es un ERROR
 * DE COMPILACIÓN, no un bug mudo.
 */
export const LivenessPhase = {
  REQUESTING_CHALLENGE: 'requesting-challenge',
  READY: 'ready',
  PERFORMING: 'performing',
  SUBMITTING: 'submitting',
  SUCCESS: 'success',
  FAILED: 'failed',
} as const satisfies Record<string, LivenessPhase>;

/**
 * Origen del último error, para que la presentación elija el mensaje correcto sin re-inspeccionar el error:
 *  - `challenge`: falló pedir el reto (red / backend). El reintento vuelve a pedirlo.
 *  - `capture`: falló capturar los frames (módulo nativo no disponible, permiso, timeout de cámara).
 *  - `enroll`: falló confirmar (enroll/submit); aquí aplica el mapeo liveness/rostro/red/genérico.
 */
export type LivenessErrorSource = 'challenge' | 'capture' | 'enroll';

/**
 * Orquesta el LIVENESS REACTIVO del alta: la PANTALLA es dueña de la máquina de estados; este hook la
 * implementa sobre IO inyectado:
 *  - reto: `useLivenessChallenge` (React Query, `GET /drivers/me/biometric/liveness/challenge`),
 *  - captura: `useLivenessGrabber().captureFrames(plan, onProgress)` (cámara frontal nativa),
 *  - enroll + cierre: `useEnrollBiometric` (`POST /drivers/biometric/enroll`) → `useRegistrationSubmit`.
 *
 * SEGURIDAD (defense-in-depth): el enroll CON LIVENESS es REQUISITO para cerrar el alta — `submit` solo
 * corre si el enroll resolvió. La guarda anti-reentrada (`submittingRef`) garantiza que un doble toque del
 * CTA no dispare la secuencia dos veces. Los retos son de UN SOLO USO: `retry()` pide un reto NUEVO.
 */
export function useRegistrationFaceCapture() {
  const grabber = useLivenessGrabber();
  const challenge = useLivenessChallenge();
  const enroll = useEnrollBiometric();
  const submit = useRegistrationSubmit();

  // Fase de UI. Arranca pidiendo el reto; los efectos de la query la promueven a `ready`/`failed`.
  const [phase, setPhase] = useState<LivenessPhase>(LivenessPhase.REQUESTING_CHALLENGE);
  const [captureProgress, setCaptureProgress] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [errorSource, setErrorSource] = useState<LivenessErrorSource | null>(null);
  // Guarda anti-reentrada de la secuencia performing→submitting: la fase se actualiza async, así que un
  // doble toque rápido entraría dos veces antes del re-render. El ref se marca SÍNCRONO para garantizar
  // que la captura+enroll+submit corran una sola vez por reto.
  const runningRef = useRef(false);

  // Datos del reto activo (derivados de la query). Disponibles solo cuando la query resolvió.
  const challengeData = challenge.data;
  const action: LivenessAction | null = challengeData?.action ?? null;
  const instructions: string | null = challengeData?.instructions ?? null;

  /**
   * Sincroniza la fase con el ciclo de la query del reto, pero SOLO mientras estamos esperando el reto
   * (fase `requesting-challenge`): así un éxito de captura/enroll posterior NO se pisa cuando la query
   * sigue "success" en background. Reto OK → `ready`; reto con error → `failed` (source `challenge`).
   */
  useEffect(() => {
    if (phase !== LivenessPhase.REQUESTING_CHALLENGE) {
      return;
    }
    if (challenge.isSuccess && challengeData) {
      setPhase(LivenessPhase.READY);
      return;
    }
    if (challenge.isError) {
      setError(challenge.error);
      setErrorSource('challenge');
      setPhase(LivenessPhase.FAILED);
    }
  }, [phase, challenge.isSuccess, challenge.isError, challenge.error, challengeData]);

  /**
   * Inicia el gesto: captura los frames del liveness (progreso real) y, al completarlos, enrola
   * `{ challengeId, frames }` y cierra el alta (MISMO orden enroll→submit que el flujo previo). El enroll
   * es prerequisito del cierre: si falla, `submit` NO corre y la fase pasa a `failed` con el error tipado.
   */
  const start = useCallback(async () => {
    if (runningRef.current || !challengeData) {
      return;
    }
    runningRef.current = true;
    setError(null);
    setErrorSource(null);
    setCaptureProgress(0);
    setPhase(LivenessPhase.PERFORMING);
    // Marca de en qué etapa estamos para clasificar el error sin re-inspeccionarlo: hasta superar la
    // captura, cualquier fallo es de cámara (`capture`); a partir del enroll, es de cierre (`enroll`).
    let stage: LivenessErrorSource = 'capture';
    try {
      const plan = planForChallenge(challengeData.action);
      const frames = await grabber.captureFrames(plan, setCaptureProgress);
      stage = 'enroll';
      setPhase(LivenessPhase.SUBMITTING);
      // Enroll CON LIVENESS (OBLIGATORIO) y, solo si resolvió, cierre del alta (server-driven).
      await enroll.mutateAsync({ challengeId: challengeData.challengeId, frames });
      await submit.mutateAsync();
      setPhase(LivenessPhase.SUCCESS);
    } catch (e) {
      runningRef.current = false;
      setError(e);
      setErrorSource(stage);
      setPhase(LivenessPhase.FAILED);
    }
  }, [challengeData, grabber, enroll, submit]);

  /**
   * Reintenta tras un fallo. Los retos son de UN SOLO USO, así que NO se reusa el reto consumido: se
   * resetea la guarda + el estado y se pide un reto NUEVO (`refetch`), volviendo a `requesting-challenge`.
   */
  const retry = useCallback(() => {
    runningRef.current = false;
    setError(null);
    setErrorSource(null);
    setCaptureProgress(0);
    setPhase(LivenessPhase.REQUESTING_CHALLENGE);
    void challenge.refetch();
  }, [challenge]);

  /**
   * Clasificación del error de CONFIRMAR (liveness / rostro / red / genérico) para que la pantalla muestre
   * el mensaje específico. Solo aplica cuando el error vino del enroll; ante un error de reto o captura es
   * `null` (esos casos los cubren los banners de reto/cámara con su propio reintento).
   */
  const enrollErrorKind: KycEnrollErrorKind | null = useMemo(
    () => (error && errorSource === 'enroll' ? classifyKycEnrollError(error) : null),
    [error, errorSource],
  );

  return {
    phase,
    action,
    instructions,
    captureProgress,
    error,
    errorSource,
    enrollErrorKind,
    isRequestingChallenge: phase === LivenessPhase.REQUESTING_CHALLENGE,
    isPerforming: phase === LivenessPhase.PERFORMING,
    isSubmitting: phase === LivenessPhase.SUBMITTING,
    isSuccess: phase === LivenessPhase.SUCCESS,
    isFailed: phase === LivenessPhase.FAILED,
    start,
    retry,
  };
}
