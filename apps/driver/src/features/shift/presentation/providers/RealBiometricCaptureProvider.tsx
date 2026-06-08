import React, {useMemo, type ReactNode} from 'react';
import {useDi} from '../../../../core/di/useDi';
import type {BiometricCaptureService, BiometricEnrollmentService} from '../../domain';
import {HttpBiometricBackendPort} from '../../data/services/http-biometric-backend';
import {LivenessBiometricCaptureService} from '../../data/services/liveness-biometric-capture';
import {nativeBiometricFrameGrabber} from '../../data/services/native-biometric-frame-grabber';
import {BiometricCaptureProvider} from './BiometricCaptureProvider';

/**
 * Construye el servicio biométrico REAL (frame-grabber nativo + backend del driver-bff) y lo inyecta
 * en el `BiometricCaptureProvider`. Se hace en presentación para que el módulo nativo de cámara solo
 * se resuelva al montar el árbol de la app (no en pruebas Jest).
 */
export const RealBiometricCaptureProvider = ({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element => {
  const {httpClient} = useDi();
  const service = useMemo<BiometricCaptureService & BiometricEnrollmentService>(
    () =>
      new LivenessBiometricCaptureService(
        nativeBiometricFrameGrabber,
        new HttpBiometricBackendPort(httpClient),
      ),
    [httpClient],
  );
  return <BiometricCaptureProvider service={service}>{children}</BiometricCaptureProvider>;
};
