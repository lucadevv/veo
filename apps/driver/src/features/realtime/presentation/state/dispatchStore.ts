import { create } from 'zustand';

/** Oferta entrante recibida por el socket `/driver` (evento `dispatch:offer`). */
export interface IncomingOffer {
  matchId: string;
  tripId: string;
  /** ISO-8601: el conductor debe responder antes de esta hora. */
  expiresAt: string;
  /** true si la oferta es un viaje PROGRAMADO (reserva). Opcional: degrada a no-reserva si falta. */
  scheduled?: boolean;
  /**
   * ETA conductor→recojo en segundos (dato EFÍMERO del momento de oferta, como `expiresAt`): la pantalla
   * de oferta lo muestra como el 3er stat "A recojo". Opcional: dispatch lo omite si `maps.eta` no estuvo
   * disponible al armar la oferta → el stat degrada a "—" en vez de mentir "0 min".
   */
  pickupEtaSeconds?: number;
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
  /**
   * ADR-021 Fase J (J4) — tripId de un viaje que ACABA de saltar de FIXED → PUJA (el conductor lo tenía
   * como "Viaje entrante" y ahora re-abrió como puja: schedule flip / rebid). BidsScreen muestra un aviso
   * "Nueva ronda · ahora es puja" para que entienda que es el MISMO viaje con otra mecánica, no una oferta
   * random nueva. Se limpia al verlo (auto-dismiss) o al tapear una puja. `null` = sin aviso.
   */
  pujaRebidNotice: string | null;
  setIncomingOffer(offer: IncomingOffer | null): void;
  setActiveTripId(tripId: string | null): void;
  setConnected(connected: boolean): void;
  /** Limpia la oferta tras aceptarla/rechazarla o cuando vence. */
  clearOffer(): void;
  /** 2b — marca una puja como "oferta enviada, esperando al pasajero". Idempotente. */
  addPendingBid(tripId: string): void;
  /** 2b — quita el pendiente al resolverse la puja (ganó → onMatch, o perdió → bid:closed). */
  clearPendingBid(tripId: string): void;
  /** J4 — fija/limpia el aviso "nueva ronda · ahora es puja" (tripId que saltó FIXED→PUJA, o null). */
  setPujaRebidNotice(tripId: string | null): void;
}

export const useDispatchStore = create<DispatchState>((set) => ({
  incomingOffer: null,
  activeTripId: null,
  connected: false,
  pendingBidTripIds: [],
  pujaRebidNotice: null,
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
  setPujaRebidNotice: (tripId) => set({ pujaRebidNotice: tripId }),
}));
