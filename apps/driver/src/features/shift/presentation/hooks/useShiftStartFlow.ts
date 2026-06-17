import { useCallback, useState } from 'react';
import { BIOMETRIC_NOT_ENROLLED } from '../../domain';
import { useBiometricCapture } from '../providers/BiometricCaptureProvider';
import { useStartShift } from './useShift';

export type ShiftStartPhase = 'idle' | 'capturing' | 'starting' | 'done';

/**
 * Orquesta el inicio de turno: captura biométrica (reto→frames→verify) → `POST /drivers/shift/start`.
 *
 * Mantiene separadas las fases para mostrar feedback preciso y para distinguir los errores reales del
 * gate biométrico (no enrolado, rechazo de liveness/match, bloqueo) del resultado del servidor.
 * Si el conductor no está enrolado, invoca `onNeedEnrollment` para llevarlo a registrar su rostro.
 */
export function useShiftStartFlow(onSuccess: () => void, onNeedEnrollment?: () => void) {
  const capture = useBiometricCapture();
  const start = useStartShift();
  const [phase, setPhase] = useState<ShiftStartPhase>('idle');
  const [error, setError] = useState<unknown>(null);
  const [score, setScore] = useState<number | null>(null);

  const run = useCallback(async () => {
    setError(null);
    setScore(null);
    try {
      setPhase('capturing');
      const { sessionRef } = await capture.captureForShiftStart();
      setPhase('starting');
      const result = await start.mutateAsync({ sessionRef });
      setScore(result.score);
      setPhase('done');
      onSuccess();
    } catch (e) {
      setPhase('idle');
      const code = e instanceof Error ? (e as { code?: string }).code : undefined;
      if (code === BIOMETRIC_NOT_ENROLLED && onNeedEnrollment) {
        // No enrolado: no es un error a mostrar, redirigimos al registro de rostro.
        onNeedEnrollment();
        return;
      }
      setError(e);
    }
  }, [capture, start, onSuccess, onNeedEnrollment]);

  return { run, phase, error, score, isBusy: phase === 'capturing' || phase === 'starting' };
}
