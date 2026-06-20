import React, { type ReactNode } from 'react';
import { nativeLivenessFrameGrabber } from '../../data';
import { LivenessCaptureProvider } from './LivenessCaptureProvider';

/**
 * Inyecta el grabber de liveness REAL (cámara frontal nativa) en el `LivenessCaptureProvider`. Se monta
 * en el árbol del wizard de registro para que la verificación de identidad capture frames de la cámara
 * real en lugar del stub de desarrollo. La resolución del módulo nativo ocurre solo al montar la app
 * (no en pruebas Jest, que usan el provider con el stub por defecto).
 */
export const RealLivenessCaptureProvider = ({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element => (
  <LivenessCaptureProvider grabber={nativeLivenessFrameGrabber}>{children}</LivenessCaptureProvider>
);
