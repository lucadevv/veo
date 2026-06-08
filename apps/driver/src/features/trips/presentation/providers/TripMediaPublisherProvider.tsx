import React, {createContext, useContext, useMemo, type ReactNode} from 'react';
import {useDi} from '../../../../core/di/useDi';
import {
  UnavailableTripMediaPublisher,
  type TripMediaPublisher,
} from '../../domain/ports/trip-media-publisher';
import {HttpPublisherTokenPort} from '../../data/services/http-publisher-token';
import {LiveKitTripPublisher} from '../../data/services/livekit-trip-publisher';

/**
 * Contexto del publisher de video del viaje. Por defecto rechaza con un error claro.
 * El provider real construye el `LiveKitTripPublisher` con el puerto de token HTTP del backend.
 *
 * Se construye en presentación (no en el contenedor de DI) para que `livekit-client` y los globals de
 * `react-native-webrtc` solo se carguen cuando la app monta el árbol, evitando que las pruebas Jest
 * carguen el módulo nativo.
 */
const TripMediaPublisherContext = createContext<TripMediaPublisher>(
  new UnavailableTripMediaPublisher(),
);

export interface TripMediaPublisherProviderProps {
  children: ReactNode;
  /** Publisher inyectable (p. ej. en pruebas). Si se omite, se usa el WebRTC real. */
  publisher?: TripMediaPublisher;
}

export const TripMediaPublisherProvider = ({
  children,
  publisher,
}: TripMediaPublisherProviderProps): React.JSX.Element => {
  const {httpClient} = useDi();
  const value = useMemo<TripMediaPublisher>(
    () => publisher ?? new LiveKitTripPublisher(new HttpPublisherTokenPort(httpClient)),
    [publisher, httpClient],
  );
  return (
    <TripMediaPublisherContext.Provider value={value}>
      {children}
    </TripMediaPublisherContext.Provider>
  );
};

/** Hook para consumir el publisher de video del viaje. */
export function useTripMediaPublisher(): TripMediaPublisher {
  return useContext(TripMediaPublisherContext);
}
