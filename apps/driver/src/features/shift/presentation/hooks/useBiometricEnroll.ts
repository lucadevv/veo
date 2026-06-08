import {useCallback, useState} from 'react';
import {useBiometricEnrollment} from '../providers/BiometricCaptureProvider';

export type EnrollPhase = 'idle' | 'capturing' | 'done';

/**
 * Orquesta el enrolamiento de rostro: captura una foto (frame-grabber nativo) y la registra en el
 * backend (`POST /drivers/biometric/enroll`). Expone fase/estado para feedback preciso en la UI.
 */
export function useBiometricEnroll(onSuccess: () => void) {
  const enrollment = useBiometricEnrollment();
  const [phase, setPhase] = useState<EnrollPhase>('idle');
  const [error, setError] = useState<unknown>(null);

  const run = useCallback(async () => {
    setError(null);
    try {
      setPhase('capturing');
      await enrollment.enroll();
      setPhase('done');
      onSuccess();
    } catch (e) {
      setPhase('idle');
      setError(e);
    }
  }, [enrollment, onSuccess]);

  return {run, phase, error, isBusy: phase === 'capturing'};
}
