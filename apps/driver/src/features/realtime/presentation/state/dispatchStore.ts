import { create } from 'zustand';

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
  /**
   * ADR-020 Lote 2 (2b) — tripIds de pujas en las que el conductor YA envió su oferta (ACCEPT/COUNTER) y
   * espera la elección del pasajero. Alimenta el estado HONESTO "Esperando al pasajero…" (enviada, NO
   * ganada). Se limpia al GANAR (onMatch) o al PERDER/cerrarse la puja (bid:closed → offer_withdrawn).
   * Estado de sesión en vivo (no server-cacheable): la verdad del outcome llega por el socket.
   */
  pendingBidTripIds: string[];
  setIncomingOffer(offer: IncomingOffer | null): void;
  setActiveTripId(tripId: string | null): void;
  setConnected(connected: boolean): void;
  /** Limpia la oferta tras aceptarla/rechazarla o cuando vence. */
  clearOffer(): void;
  /** 2b — marca una puja como "oferta enviada, esperando al pasajero". Idempotente. */
  addPendingBid(tripId: string): void;
  /** 2b — quita el pendiente al resolverse la puja (ganó → onMatch, o perdió → bid:closed). */
  clearPendingBid(tripId: string): void;
}

export const useDispatchStore = create<DispatchState>((set) => ({
  incomingOffer: null,
  activeTripId: null,
  connected: false,
  pendingBidTripIds: [],
  setIncomingOffer: (offer) => set({ incomingOffer: offer }),
  setActiveTripId: (tripId) => set({ activeTripId: tripId }),
  setConnected: (connected) => set({ connected }),
  clearOffer: () => set({ incomingOffer: null }),
  addPendingBid: (tripId) =>
    set((s) =>
      s.pendingBidTripIds.includes(tripId)
        ? s
        : { pendingBidTripIds: [...s.pendingBidTripIds, tripId] },
    ),
  clearPendingBid: (tripId) =>
    set((s) => ({ pendingBidTripIds: s.pendingBidTripIds.filter((id) => id !== tripId) })),
}));
