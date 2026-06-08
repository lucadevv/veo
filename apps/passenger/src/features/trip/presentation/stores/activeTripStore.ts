import { create } from 'zustand';

export interface ActiveTripState {
  /**
   * Id del viaje VIVO del pasajero (o `null` si está en el home sin viaje en curso). Es la fuente de
   * verdad del flujo unificado que SOBREVIVE al desmontaje de la pantalla (a diferencia de un
   * `useState`): el tab Home se desmonta por `detachInactiveScreens`, pero este store persiste en
   * memoria, así al volver el sheet re-entra al viaje. El estado autoritativo vive en el server: el id
   * se ADOPTA al crear un viaje (local) o al rehidratar desde `GET /trips/active`.
   */
  activeTripId: string | null;
  /** Adopta un viaje activo (creación local o rehidratación desde el server). */
  setActiveTripId: (tripId: string) => void;
  /** Limpia el viaje (terminal/cancelado → vuelve al home idle). */
  clear: () => void;
}

/**
 * Store del VIAJE ACTIVO (estado de cliente puro, Zustand). NO contiene el detalle del viaje (eso lo
 * trae React Query por id); solo el `activeTripId` como ancla estable del flujo unificado. En memoria
 * a propósito (sin MMKV): la fuente de verdad es el server — al arrancar/enfocar se rehidrata vía
 * `GET /trips/active`, así nunca queda un id colgado de una sesión vieja.
 */
export const useActiveTripStore = create<ActiveTripState>((set) => ({
  activeTripId: null,
  setActiveTripId: (activeTripId) => set({ activeTripId }),
  clear: () => set({ activeTripId: null }),
}));
