'use client';

import { create } from 'zustand';
import { DRIVER_LOC_TTL_SECONDS_DEFAULT } from '@veo/shared-types';
import type { DriverLocationMsg, PanicAlertMsg, TripUpdateMsg } from '@veo/api-client';
import type { SocketStatus } from './ops-socket';

/**
 * Colchón (ms) que el cliente suma al TTL del hot-index del backend. La poda debe ser MÁS INDULGENTE
 * que el backend, nunca más agresiva: sacar del mapa a un conductor que el hot-index todavía considera
 * vivo produce un marker que parpadea (peor UX que un fantasma que dura 1-2s de más). El colchón absorbe
 * el jitter de red y los reintentos del publisher del conductor.
 */
const DRIVER_STALE_GRACE_MS = 5_000;

/**
 * Ventana de frescura para la poda de markers del mapa `/ops`. Derivada de la FUENTE ÚNICA compartida
 * con el backend (`DRIVER_LOC_TTL_SECONDS_DEFAULT`), no un número mágico duplicado: un conductor cuya
 * última muestra sea más vieja que esto se considera desconectado y se saca del mapa.
 */
export const DRIVER_STALE_MS = DRIVER_LOC_TTL_SECONDS_DEFAULT * 1_000 + DRIVER_STALE_GRACE_MS;

/**
 * Cadencia del sweep periódico que poda los markers stale. Es un parámetro CLIENT-ONLY (no compartido
 * con el backend): controla cada cuánto se re-evalúa la frescura, no la semántica de expiración.
 */
export const DRIVER_SWEEP_INTERVAL_MS = 10_000;

/**
 * Un conductor vivo en el mapa: su última muestra + el instante LOCAL en que llegó.
 *
 * La poda compara contra `receivedAt` (reloj del NAVEGADOR), NO contra `msg.at` (timestamp del backend):
 * un SOLO reloj a ambos lados de la resta ⇒ cero drift entre el clock del servidor y el del cliente.
 * Comparar `msg.at` (server) contra `Date.now()` (cliente) haría que un skew de relojes podara conductores
 * vivos o retuviera fantasmas. `msg.at` queda solo para presentación/orden, nunca para decidir liveness.
 */
export interface LiveDriver {
  msg: DriverLocationMsg;
  receivedAt: number;
}

interface OpsState {
  status: SocketStatus;
  drivers: Record<string, LiveDriver>;
  trips: Record<string, TripUpdateMsg>;
  /** Pánicos activos recibidos en vivo (para el banner global). */
  panics: PanicAlertMsg[];
  setStatus: (status: SocketStatus) => void;
  upsertDriver: (msg: DriverLocationMsg, now?: number) => void;
  /**
   * Saca del store los conductores cuya última muestra excede la ventana de frescura (offline).
   * No-op ESTABLE: si nada vencía, devuelve el mismo estado por referencia → zustand no notifica,
   * no hay re-render y el `Record` de drivers conserva su identidad (los selectores/useMemo no corren).
   */
  pruneStaleDrivers: (now?: number) => void;
  upsertTrip: (msg: TripUpdateMsg) => void;
  addPanic: (msg: PanicAlertMsg) => void;
  updatePanic: (panicId: string, status: string) => void;
  dismissPanic: (panicId: string) => void;
}

export const useOpsStore = create<OpsState>((set) => ({
  status: 'idle',
  drivers: {},
  trips: {},
  panics: [],
  setStatus: (status) => set({ status }),
  upsertDriver: (msg, now = Date.now()) =>
    set((s) => ({ drivers: { ...s.drivers, [msg.driverId]: { msg, receivedAt: now } } })),
  pruneStaleDrivers: (now = Date.now()) =>
    set((s) => {
      const cutoff = now - DRIVER_STALE_MS;
      let changed = false;
      const next: Record<string, LiveDriver> = {};
      for (const [id, entry] of Object.entries(s.drivers)) {
        if (entry.receivedAt >= cutoff) next[id] = entry;
        else changed = true;
      }
      // Mismo estado por referencia cuando no se podó nada ⇒ zustand omite la notificación (sin re-render).
      return changed ? { drivers: next } : s;
    }),
  upsertTrip: (msg) => set((s) => ({ trips: { ...s.trips, [msg.tripId]: msg } })),
  addPanic: (msg) =>
    set((s) =>
      s.panics.some((p) => p.panicId === msg.panicId) ? s : { panics: [msg, ...s.panics] },
    ),
  updatePanic: (panicId, status) =>
    set((s) => ({
      panics: s.panics.map((p) => (p.panicId === panicId ? { ...p, status } : p)),
    })),
  dismissPanic: (panicId) =>
    set((s) => ({ panics: s.panics.filter((p) => p.panicId !== panicId) })),
}));

// Aid de DEV: expone el store para inyectar markers de prueba desde la consola (probar el mapa sin
// conductores online). Nunca en producción; no altera el flujo real (los markers siguen viniendo del socket).
declare global {
  interface Window {
    __opsStore?: typeof useOpsStore;
  }
}
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  window.__opsStore = useOpsStore;
}
