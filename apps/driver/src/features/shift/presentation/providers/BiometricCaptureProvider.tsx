import React, { createContext, useContext, type ReactNode } from 'react';
import {
  UnavailableBiometricCaptureService,
  type BiometricCaptureService,
  type BiometricEnrollmentService,
} from '../../domain';

/** El servicio real implementa ambos puertos (captura de turno + enrolamiento). */
type BiometricService = BiometricCaptureService & BiometricEnrollmentService;

/**
 * Contexto del servicio biométrico. Por defecto usa la implementación que lanza un error claro
 * ("captura nativa no instalada"). La capa de presentación monta el servicio real (frame-grabber
 * nativo + backend) en la raíz, sin cambiar la UI del flujo de turno/enrolamiento.
 */
const defaultService: BiometricService = new UnavailableBiometricCaptureService();
const BiometricCaptureContext = createContext<BiometricService>(defaultService);

export interface BiometricCaptureProviderProps {
  children: ReactNode;
  /** Servicio real inyectado por la capa de presentación. Si se omite, se usa el que lanza error. */
  service?: BiometricService;
}

export const BiometricCaptureProvider = ({
  children,
  service,
}: BiometricCaptureProviderProps): React.JSX.Element => (
  <BiometricCaptureContext.Provider value={service ?? defaultService}>
    {children}
  </BiometricCaptureContext.Provider>
);

/** Hook para consumir el puerto de captura biométrica (inicio de turno). */
export function useBiometricCapture(): BiometricCaptureService {
  return useContext(BiometricCaptureContext);
}

/** Hook para consumir el puerto de enrolamiento biométrico (registro de rostro). */
export function useBiometricEnrollment(): BiometricEnrollmentService {
  return useContext(BiometricCaptureContext);
}
