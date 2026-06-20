import React, { createContext, useContext, type ReactNode } from 'react';
import { getContainer, type AppContainer, type AppRepositories } from './container';

/**
 * Acceso al contenedor de DI desde React.
 *
 * Por defecto usa el singleton (`getContainer()`); el `DiProvider` permite inyectar un contenedor
 * alternativo (p. ej. en pruebas de componentes) sin acoplar los hooks a la implementación.
 */
const ContainerContext = createContext<AppContainer | null>(null);

export interface DiProviderProps {
  children: ReactNode;
  /** Contenedor a inyectar; si se omite, se usa el singleton de la app. */
  container?: AppContainer;
}

export const DiProvider = ({ children, container }: DiProviderProps): React.JSX.Element => (
  <ContainerContext.Provider value={container ?? getContainer()}>
    {children}
  </ContainerContext.Provider>
);

/** Devuelve el contenedor activo (el inyectado por `DiProvider` o el singleton). */
export function useDi(): AppContainer {
  return useContext(ContainerContext) ?? getContainer();
}

/** Atajo para acceder a los repositorios desde hooks de feature. */
export function useRepositories(): AppRepositories {
  return useDi().repositories;
}

/** Atajo para el uploader del binario de documentos (presign + PUT crudo al almacén soberano). */
export function useDocumentUploader(): AppContainer['documentUploader'] {
  return useDi().documentUploader;
}

/** Atajo para el picker de imágenes (cámara/galería) del binario de documentos. */
export function useImagePicker(): AppContainer['imagePicker'] {
  return useDi().imagePicker;
}

/** Atajo para el escáner nativo de documentos (bordes + auto-captura) del binario de documentos. */
export function useDocumentScanner(): AppContainer['documentScanner'] {
  return useDi().documentScanner;
}
