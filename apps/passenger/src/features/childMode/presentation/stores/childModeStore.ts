import { create } from 'zustand';

/**
 * Estado de cliente del Modo Niño (Zustand, SOLO en memoria). El código (4-6 dígitos) se adjunta a
 * `POST /trips` (`childMode`/`childCode`) y NO se persiste por seguridad: nunca debe quedar en
 * disco ni mostrarse al conductor (el bff valida un hash server-side).
 */
interface ChildModeState {
  enabled: boolean;
  code: string;
  setEnabled: (enabled: boolean) => void;
  setCode: (code: string) => void;
  /** Limpia el código tras usarse en una solicitud de viaje. */
  reset: () => void;
}

export const useChildModeStore = create<ChildModeState>((set) => ({
  enabled: false,
  code: '',
  setEnabled: (enabled) => set({ enabled }),
  setCode: (code) => set({ code: code.replace(/\D/g, '').slice(0, 6) }),
  reset: () => set({ enabled: false, code: '' }),
}));
