'use client';

import { create } from 'zustand';
import type { DriverLocationMsg, PanicAlertMsg, TripUpdateMsg } from '@veo/api-client';
import type { SocketStatus } from './ops-socket';

interface OpsState {
  status: SocketStatus;
  drivers: Record<string, DriverLocationMsg>;
  trips: Record<string, TripUpdateMsg>;
  /** Pánicos activos recibidos en vivo (para el banner global). */
  panics: PanicAlertMsg[];
  setStatus: (status: SocketStatus) => void;
  upsertDriver: (msg: DriverLocationMsg) => void;
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
  upsertDriver: (msg) => set((s) => ({ drivers: { ...s.drivers, [msg.driverId]: msg } })),
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
