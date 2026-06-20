import React, { createContext, useContext, type ReactNode } from 'react';
import type { LivenessFrameGrabber } from '../../domain';
import { stubLivenessFrameGrabber } from '../../data';

/**
 * Contexto del puerto de captura de LIVENESS del registro (KYC del alta). El valor por defecto es el
 * STUB de desarrollo (frames marcadores con progreso real), de modo que el flujo de KYC funciona sin
 * montar un provider en el árbol raíz (y las pruebas Jest, que no tienen módulo nativo, lo usan).
 *
 * En producción se envuelve el árbol del wizard con `<RealLivenessCaptureProvider>` para inyectar el
 * grabber nativo (cámara frontal real). El RETO de liveness NO vive aquí: lo pide la pantalla vía el
 * repositorio (`useLivenessChallenge`), para mantener al grabber como IO puro de cámara.
 */
const LivenessCaptureContext = createContext<LivenessFrameGrabber>(stubLivenessFrameGrabber);

export interface LivenessCaptureProviderProps {
  children: ReactNode;
  /** Grabber a inyectar; si se omite, se usa el stub de desarrollo por defecto. */
  grabber?: LivenessFrameGrabber;
}

export const LivenessCaptureProvider = ({
  children,
  grabber,
}: LivenessCaptureProviderProps): React.JSX.Element => (
  <LivenessCaptureContext.Provider value={grabber ?? stubLivenessFrameGrabber}>
    {children}
  </LivenessCaptureContext.Provider>
);

/** Devuelve el grabber de liveness activo (el inyectado o el stub de desarrollo por defecto). */
export function useLivenessGrabber(): LivenessFrameGrabber {
  return useContext(LivenessCaptureContext);
}
