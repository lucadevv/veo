import React, { createContext, useContext, type ReactNode } from 'react';
import { unavailableLocationSource, type LocationSource } from '../../domain/location-source';

/**
 * Contexto de la fuente de GPS nativa. Por defecto no emite (`unavailableLocationSource`).
 * La oleada nativa montará este provider con la fuente real (background-geolocation).
 */
const LocationSourceContext = createContext<LocationSource>(unavailableLocationSource);

export interface LocationSourceProviderProps {
  children: ReactNode;
  source?: LocationSource;
}

export const LocationSourceProvider = ({
  children,
  source,
}: LocationSourceProviderProps): React.JSX.Element => (
  <LocationSourceContext.Provider value={source ?? unavailableLocationSource}>
    {children}
  </LocationSourceContext.Provider>
);

/** Hook para consumir la fuente de GPS nativa. */
export function useLocationSource(): LocationSource {
  return useContext(LocationSourceContext);
}
