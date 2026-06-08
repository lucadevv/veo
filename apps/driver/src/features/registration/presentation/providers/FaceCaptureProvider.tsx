import React, {createContext, useContext, type ReactNode} from 'react';
import type {FaceCaptureService} from '../../domain';
import {stubFaceCaptureService} from '../../data';

/**
 * Contexto del puerto de captura facial del registro. El valor por defecto es el STUB de
 * desarrollo (referencia opaca local), de modo que el flujo de KYC del alta funciona sin montar un
 * provider en el árbol raíz.
 *
 * TODO(nativo/DI): cuando exista el módulo de captura real, envolver el árbol con
 * `<FaceCaptureProvider service={realFaceCaptureService}>` o registrarlo en el contenedor de DI.
 * El dominio ofrece `UnavailableFaceCaptureService` como alternativa segura para pruebas.
 */
const FaceCaptureContext = createContext<FaceCaptureService>(stubFaceCaptureService);

export interface FaceCaptureProviderProps {
  children: ReactNode;
  /** Servicio a inyectar; si se omite, se usa el stub de desarrollo por defecto. */
  service?: FaceCaptureService;
}

export const FaceCaptureProvider = ({
  children,
  service,
}: FaceCaptureProviderProps): React.JSX.Element => (
  <FaceCaptureContext.Provider value={service ?? stubFaceCaptureService}>
    {children}
  </FaceCaptureContext.Provider>
);

/** Devuelve el servicio de captura facial activo (el inyectado o el "no disponible"). */
export function useFaceCapture(): FaceCaptureService {
  return useContext(FaceCaptureContext);
}
