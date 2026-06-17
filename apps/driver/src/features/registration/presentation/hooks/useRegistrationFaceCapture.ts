import { useCallback, useRef, useState } from 'react';
import type { FaceCapture } from '../../domain';
import { useRegistrationStore } from '../state/registrationStore';
import { useFaceCapture } from '../providers/FaceCaptureProvider';
import { useRegistrationSubmit } from './useRegistrationSubmit';
import { useEnrollBiometric } from './useRegistrationDocuments';

/**
 * Fase del flujo de KYC del alta (estado de PRESENTACIÓN, no de negocio):
 *  - `idle`: guía en pantalla, listo para capturar.
 *  - `capturing`: cámara nativa abierta tomando la foto.
 *  - `preview`: foto capturada en pantalla; el conductor confirma o vuelve a tomar.
 *  - `submitting`: enrolando la foto (`POST /drivers/biometric/enroll`) + cerrando el alta.
 */
export type FaceCapturePhase = 'idle' | 'capturing' | 'preview' | 'submitting';

/**
 * Orquesta la captura facial REAL del alta: captura (cámara nativa) → preview/reintento → confirmar
 * (enrolar la foto + cerrar el alta). La lógica vive en el servicio inyectado (`FaceCaptureService`)
 * y en las mutaciones (`useEnrollBiometric`/`useRegistrationSubmit`); aquí solo se gobierna la fase
 * de UI. Al cerrar el alta, el store pasa a `in_review` y el `RootNavigator` conmuta de pantalla.
 */
export function useRegistrationFaceCapture() {
  const faceCapture = useFaceCapture();
  const setFaceCapture = useRegistrationStore((s) => s.setFaceCapture);
  const enroll = useEnrollBiometric();
  const submit = useRegistrationSubmit();

  const [phase, setPhase] = useState<FaceCapturePhase>('idle');
  const [capture, setCapture] = useState<FaceCapture | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Guarda anti-reentrada de `confirm`: el estado (`phase`) se actualiza de forma asíncrona, así que
  // un doble toque rápido entraría dos veces antes del re-render. El ref se marca SÍNCRONAMENTE para
  // garantizar que enroll+submit se ejecuten una sola vez por captura.
  const submittingRef = useRef(false);

  /** Abre la cámara nativa, captura la foto y pasa a preview (persiste la referencia en el store). */
  const startCapture = useCallback(async () => {
    setError(null);
    setPhase('capturing');
    try {
      const result = await faceCapture.captureForRegistration();
      setCapture(result);
      setFaceCapture(result);
      setPhase('preview');
    } catch (e) {
      setPhase('idle');
      setError(e);
    }
  }, [faceCapture, setFaceCapture]);

  /** Descarta la foto y vuelve a la guía para reintentar. */
  const retake = useCallback(() => {
    setError(null);
    setCapture(null);
    submittingRef.current = false;
    setPhase('idle');
  }, []);

  /**
   * Confirma la foto: la enrola en el backend (si el proveedor entregó base64 real) y cierra el alta
   * (queda `in_review`). Ante error, vuelve a preview para reintentar sin perder la foto.
   *
   * PRODUCTO: este enroll del ALTA captura la FOTO DE REFERENCIA del conductor (sin liveness, por
   * decisión de producto). El liveness/anti-spoofing NO vive aquí: se exige en el GATE DE TURNO
   * (verificación biométrica obligatoria al iniciar turno), que compara contra esta referencia. No
   * cambiar este flujo para añadir liveness en el alta.
   *
   * SEGURIDAD/UX: guarda anti-reentrada — un doble toque del botón confirmar NO debe disparar
   * enroll+submit dos veces. El ref se marca síncrono y se libera solo si el intento falla (para
   * permitir reintentar desde preview); en éxito el alta avanza y el componente se desmonta.
   */
  const confirm = useCallback(async () => {
    if (submittingRef.current) {
      return;
    }
    submittingRef.current = true;
    setError(null);
    setPhase('submitting');
    try {
      if (capture?.photoBase64) {
        await enroll.mutateAsync({ photo: capture.photoBase64 });
      }
      await submit.mutateAsync();
    } catch (e) {
      submittingRef.current = false;
      setPhase('preview');
      setError(e);
    }
  }, [capture, enroll, submit]);

  return {
    phase,
    capture,
    error,
    isCapturing: phase === 'capturing',
    isSubmitting: phase === 'submitting',
    startCapture,
    retake,
    confirm,
  };
}
