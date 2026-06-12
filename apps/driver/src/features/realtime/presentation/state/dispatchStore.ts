import {create} from 'zustand';

/** Oferta entrante recibida por el socket `/driver` (evento `dispatch:offer`). */
export interface IncomingOffer {
  matchId: string;
  tripId: string;
  /** ISO-8601: el conductor debe responder antes de esta hora. */
  expiresAt: string;
  /** true si la oferta es un viaje PROGRAMADO (reserva). Opcional: degrada a no-reserva si falta. */
  scheduled?: boolean;
}

/**
 * Estado transitorio de despacho (UI/sesión): la oferta entrante actual y el viaje activo conocido.
 * Vive en Zustand porque es estado de UI/sesión en vivo (no estado de servidor cacheable).
 */
export interface DispatchState {
  incomingOffer: IncomingOffer | null;
  activeTripId: string | null;
  /**
   * ¿El socket `/driver` está conectado AHORA? Estado de sesión en vivo (lo fija `useDriverRealtime`
   * en los handlers `connect`/`disconnect`). Las pantallas lo leen para mostrar el indicador de
   * conexión: si está `false` (túnel, zona muerta), el conductor ve "Reconectando…" en vez de creer
   * que recibe eventos en vivo cuando en realidad está aislado. Arranca `false` (aún sin conectar).
   */
  connected: boolean;
  setIncomingOffer(offer: IncomingOffer | null): void;
  setActiveTripId(tripId: string | null): void;
  setConnected(connected: boolean): void;
  /** Limpia la oferta tras aceptarla/rechazarla o cuando vence. */
  clearOffer(): void;
}

export const useDispatchStore = create<DispatchState>(set => ({
  incomingOffer: null,
  activeTripId: null,
  connected: false,
  setIncomingOffer: offer => set({incomingOffer: offer}),
  setActiveTripId: tripId => set({activeTripId: tripId}),
  setConnected: connected => set({connected}),
  clearOffer: () => set({incomingOffer: null}),
}));
