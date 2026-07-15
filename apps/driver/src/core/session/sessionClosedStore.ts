import { create } from 'zustand';

/**
 * Motivo por el que la sesión se cerró de forma REMOTA (no por logout del propio conductor):
 *  - `superseded`: inició sesión en OTRO dispositivo (single active session).
 *  - `revoked`: el gateway rechazó el handshake (logout remoto, suspensión, sesión revocada).
 */
export type SessionClosedReason = 'superseded' | 'revoked';

interface SessionClosedState {
  /** Motivo del cierre remoto, o `null` si la sesión no se cerró remotamente. */
  reason: SessionClosedReason | null;
  /** Marca el cierre remoto con su motivo (lo fija `RealtimeManager` al revocar). */
  setReason(reason: SessionClosedReason): void;
  /** Limpia el aviso (al tocar "Volver a ingresar"): deja pasar al login. */
  clear(): void;
}

/**
 * Señal EFÍMERA del cierre remoto de sesión. Vive fuera del `sessionStore` (que solo modela auth) para
 * no acoplar el aviso de UI al contrato de sesión. `RealtimeManager` la fija cuando el socket informa
 * `superseded`/`revoked`; el `RootNavigator` la lee (ya sin sesión) para mostrar `SessionClosedScreen`
 * ANTES de volver al login, en vez de mandar a login en silencio (frame `C/Sesion-Cerrada`).
 */
export const useSessionClosedStore = create<SessionClosedState>((set) => ({
  reason: null,
  setReason: (reason) => set({ reason }),
  clear: () => set({ reason: null }),
}));
