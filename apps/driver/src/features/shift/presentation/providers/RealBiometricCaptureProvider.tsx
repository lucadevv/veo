import React, { useMemo, type ReactNode } from 'react';
import { useDi } from '../../../../core/di/useDi';
import type { BiometricCaptureService, BiometricEnrollmentService } from '../../domain';
import type { BiometricFrameGrabber } from '../../domain';
import { HttpBiometricBackendPort } from '../../data/services/http-biometric-backend';
import { LivenessBiometricCaptureService } from '../../data/services/liveness-biometric-capture';
import {
  nativeBiometricFrameGrabber,
  nativeBiometricFrameGrabberLinked,
} from '../../data/services/native-biometric-frame-grabber';
import { stubBiometricFrameGrabber } from '../../data/services/stub-biometric-frame-grabber';
import { BiometricCaptureProvider } from './BiometricCaptureProvider';

/**
 * Elige el frame-grabber. En PRODUCCIÓN siempre el nativo. SOLO en dev (`__DEV__`) y cuando el módulo
 * nativo de cámara NO está enlazado (simulador), cae al stub sintético para poder probar el gate
 * biométrico de turno sin cámara real. El veredicto lo sigue dando el backend (sandbox en dev). El
 * `__DEV__` garantiza que el stub se elimina de los bundles de release.
 */
function selectFrameGrabber(): BiometricFrameGrabber {
  if (__DEV__ && !nativeBiometricFrameGrabberLinked) {
    // eslint-disable-next-line no-console
    console.warn(
      '[VEO][dev] Frame-grabber biométrico nativo no enlazado (simulador): usando stub sintético. ' +
        'El backend debe estar en VEO_BIOMETRIC_MODE=sandbox. Esto NO ocurre en builds de release.',
    );
    return stubBiometricFrameGrabber;
  }
  return nativeBiometricFrameGrabber;
}

/**
 * Construye el servicio biométrico REAL (frame-grabber + backend del driver-bff) y lo inyecta en el
 * `BiometricCaptureProvider`. Se hace en presentación para que el módulo nativo de cámara solo se
 * resuelva al montar el árbol de la app (no en pruebas Jest). En el simulador el grabber es un stub
 * dev (ver `selectFrameGrabber`); el resto del flujo es real.
 */
export const RealBiometricCaptureProvider = ({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element => {
  const { httpClient } = useDi();
  const service = useMemo<BiometricCaptureService & BiometricEnrollmentService>(
    () =>
      new LivenessBiometricCaptureService(
        selectFrameGrabber(),
        new HttpBiometricBackendPort(httpClient),
      ),
    [httpClient],
  );
  return <BiometricCaptureProvider service={service}>{children}</BiometricCaptureProvider>;
};
