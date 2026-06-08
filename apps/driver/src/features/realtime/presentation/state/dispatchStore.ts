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
  setIncomingOffer(offer: IncomingOffer | null): void;
  setActiveTripId(tripId: string | null): void;
  /** Limpia la oferta tras aceptarla/rechazarla o cuando vence. */
  clearOffer(): void;
}

export const useDispatchStore = create<DispatchState>(set => ({
  incomingOffer: null,
  activeTripId: null,
  setIncomingOffer: offer => set({incomingOffer: offer}),
  setActiveTripId: tripId => set({activeTripId: tripId}),
  clearOffer: () => set({incomingOffer: null}),
}));
