import {create} from 'zustand';
import type {PricingMode} from '@veo/api-client';

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
   * Modo de despacho AUTORITATIVO del viaje activo (PUJA | FIXED), CONGELADO por el server al crear
   * (ADR 011). Se co-loca acá con el id porque es un atributo estable y decisivo para la MÁQUINA DE FASES:
   * un FIXED EXPIRED (sin conductor) NO va a la pantalla de "re-pujar" (esa es de PUJA) sino a su propio
   * estado terminal. `null` = desconocido (sin viaje o modo no adoptado) → la fase degrada al comportamiento
   * PUJA histórico (no hay regresión). Se setea al crear (`onTripCreated`) y al rehidratar.
   */
  activeTripMode: PricingMode | null;
  /**
   * Id del enlace de seguimiento ACTIVO de la sesión actual (o `null` si no se compartió, o ya se
   * revocó). Se retiene al crear el enlace para poder REVOCARLO (kill-switch): antes la app lo
   * descartaba y el endpoint de revoke quedaba inalcanzable (auditoría R3).
   */
  activeShareId: string | null;
  /** Caducidad ISO-8601 del enlace activo (para el countdown "Expira en …"). `null` sin enlace. */
  shareExpiresAt: string | null;
  /**
   * URL pública del enlace activo de la sesión. Se RETIENE porque el backend no tiene GET del share
   * activo y el POST no dedupea sin dedupKey: sin esto, re-entrar a "Comparte tu viaje" crearía un
   * enlace nuevo cada vez. `null` si el enlace se creó por un camino que no la retuvo (legacy).
   */
  shareUrl: string | null;
  /** Adopta un viaje activo (creación local o rehidratación desde el server). */
  setActiveTripId: (tripId: string) => void;
  /** Fija el modo de despacho del viaje activo (PUJA | FIXED); se conoce al crear/rehidratar. */
  setActiveTripMode: (mode: PricingMode) => void;
  /** Retiene el enlace recién creado (shareId + caducidad + URL) para revocar/reusar/countdown. */
  setActiveShare: (shareId: string, expiresAt: string, url?: string) => void;
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
  activeTripMode: null,
  activeShareId: null,
  shareExpiresAt: null,
  shareUrl: null,
  setActiveTripId: activeTripId => set({activeTripId}),
  setActiveTripMode: activeTripMode => set({activeTripMode}),
  setActiveShare: (activeShareId, shareExpiresAt, url) =>
    set({activeShareId, shareExpiresAt, shareUrl: url ?? null}),
  clearShare: () =>
    set({activeShareId: null, shareExpiresAt: null, shareUrl: null}),
  // El `clear` del viaje DEBE arrastrar el enlace: si no, un share viejo quedaría colgado al
  // arrancar un viaje nuevo (regresión del lifecycle → botón de revoke apuntando a un link ajeno).
  clear: () =>
    set({
      activeTripId: null,
      activeTripMode: null,
      activeShareId: null,
      shareExpiresAt: null,
      shareUrl: null,
    }),
}));
