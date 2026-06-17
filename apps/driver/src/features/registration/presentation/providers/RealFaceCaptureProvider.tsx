import React, { type ReactNode } from 'react';
import { nativeFaceCaptureService } from '../../data';
import { FaceCaptureProvider } from './FaceCaptureProvider';

/**
 * Inyecta el servicio de captura facial REAL (cámara frontal nativa) en el `FaceCaptureProvider`.
 * Se monta en el árbol del wizard de registro para que la verificación de identidad use la cámara
 * del dispositivo en lugar del stub de desarrollo. La resolución del módulo nativo ocurre solo al
 * montar la app (no en pruebas Jest, que usan el provider con el stub por defecto).
 */
export const RealFaceCaptureProvider = ({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element => (
  <FaceCaptureProvider service={nativeFaceCaptureService}>{children}</FaceCaptureProvider>
);
