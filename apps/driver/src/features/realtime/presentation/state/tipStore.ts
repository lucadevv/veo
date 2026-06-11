import {create} from 'zustand';

/** Propina recibida en vivo (socket `payment:tip`). El 100% es del conductor. */
export interface ReceivedTip {
  tripId: string;
  /** Monto de la propina en céntimos (entero positivo). */
  tipCents: number;
}

/**
 * Estado transitorio de la última propina recibida. Vive en Zustand (no es estado de servidor
 * cacheable): el dashboard la celebra con un banner que el conductor descarta. El monto "real"
 * acumulado ya vive en ganancias (react-query); esto es solo el aviso en vivo.
 */
export interface TipState {
  lastTip: ReceivedTip | null;
  setTip(tip: ReceivedTip): void;
  /** Descarta el aviso (el conductor cerró el banner). */
  clearTip(): void;
}

export const useTipStore = create<TipState>(set => ({
  lastTip: null,
  setTip: tip => set({lastTip: tip}),
  clearTip: () => set({lastTip: null}),
}));
