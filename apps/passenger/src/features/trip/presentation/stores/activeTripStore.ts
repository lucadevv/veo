import {create} from 'zustand';

export interface ActiveTripState {
  /**
   * Id del viaje VIVO del pasajero (o `null` si está en el home sin viaje en curso). Es la fuente de
   * verdad del flujo unificado que SOBREVIVE al desmontaje de la pantalla (a diferencia de un
   * `useState`): el tab Home se desmonta por `detachInactiveScreens`, pero este store persiste en
   * memoria, así al volver el sheet re-entra al viaje. El estado autoritativo vive en el server: el id
   * se ADOPTA al crear un viaje (local) o al rehidratar desde `GET /trips/active`.
   */
  activeTripId: string | null;
  /**
   * Id del enlace de seguimiento ACTIVO de la sesión actual (o `null` si no se compartió, o ya se
   * revocó). Se retiene al crear el enlace para poder REVOCARLO (kill-switch): antes la app lo
   * descartaba y el endpoint de revoke quedaba inalcanzable (auditoría R3).
   */
  activeShareId: string | null;
  /** Caducidad ISO-8601 del enlace activo (para el countdown "Expira en …"). `null` sin enlace. */
  shareExpiresAt: string | null;
  /** Adopta un viaje activo (creación local o rehidratación desde el server). */
  setActiveTripId: (tripId: string) => void;
  /** Retiene el enlace recién creado (shareId + caducidad) para poder revocarlo y mostrar el countdown. */
  setActiveShare: (shareId: string, expiresAt: string) => void;
  /** Olvida el enlace activo (tras revocar o al terminar el viaje). NO toca el viaje en sí. */
  clearShare: () => void;
  /** Limpia el viaje (terminal/cancelado → vuelve al home idle). Limpia también el enlace compartido. */
  clear: () => void;
}

/**
 * Store del VIAJE ACTIVO (estado de cliente puro, Zustand). NO contiene el detalle del viaje (eso lo
 * trae React Query por id); solo el `activeTripId` como ancla estable del flujo unificado. En memoria
 * a propósito (sin MMKV): la fuente de verdad es el server — al arrancar/enfocar se rehidrata vía
 * `GET /trips/active`, así nunca queda un id colgado de una sesión vieja.
 */
export const useActiveTripStore = create<ActiveTripState>(set => ({
  activeTripId: null,
  activeShareId: null,
  shareExpiresAt: null,
  setActiveTripId: activeTripId => set({activeTripId}),
  setActiveShare: (activeShareId, shareExpiresAt) =>
    set({activeShareId, shareExpiresAt}),
  clearShare: () => set({activeShareId: null, shareExpiresAt: null}),
  // El `clear` del viaje DEBE arrastrar el enlace: si no, un share viejo quedaría colgado al
  // arrancar un viaje nuevo (regresión del lifecycle → botón de revoke apuntando a un link ajeno).
  clear: () =>
    set({activeTripId: null, activeShareId: null, shareExpiresAt: null}),
}));
