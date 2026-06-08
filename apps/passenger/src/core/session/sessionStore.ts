import type { MobileSessionUser } from '@veo/api-client';
import { create } from 'zustand';
import { secureStore } from '../storage/mmkv';

/** Claves de persistencia en el almacén seguro. */
const KEYS = {
  accessToken: 'session.accessToken',
  refreshToken: 'session.refreshToken',
  user: 'session.user',
} as const;

/** Estado de autenticación de alto nivel para decidir el flujo de navegación. */
export type SessionStatus =
  | 'unknown' // aún no se hidrató desde el almacenamiento
  | 'authenticated'
  | 'unauthenticated';

export interface SessionState {
  accessToken: string | null;
  refreshToken: string | null;
  user: MobileSessionUser | null;
  status: SessionStatus;

  /** Carga la sesión persistida (llamar al arrancar la app). */
  hydrate: () => void;
  /** Persiste una sesión completa tras verificar el OTP. */
  setSession: (params: {
    accessToken: string;
    refreshToken: string;
    user: MobileSessionUser;
  }) => void;
  /** Actualiza sólo los tokens (tras un refresh). */
  setTokens: (accessToken: string, refreshToken: string) => void;
  /** Cierra la sesión y limpia el almacenamiento seguro. */
  clearSession: () => void;
}

/**
 * Store de sesión (Zustand). Estado de cliente puro: tokens + usuario.
 * Persistencia manual en el almacén seguro (MMKV cifrado), no en el estado de servidor
 * (React Query). El `HttpClient` lee `accessToken` desde aquí vía `getState()`.
 */
export const useSessionStore = create<SessionState>((set) => ({
  accessToken: null,
  refreshToken: null,
  user: null,
  status: 'unknown',

  hydrate: () => {
    const accessToken = secureStore.getString(KEYS.accessToken) ?? null;
    const refreshToken = secureStore.getString(KEYS.refreshToken) ?? null;
    const user = secureStore.getJSON<MobileSessionUser>(KEYS.user) ?? null;
    set({
      accessToken,
      refreshToken,
      user,
      status: accessToken ? 'authenticated' : 'unauthenticated',
    });
  },

  setSession: ({ accessToken, refreshToken, user }) => {
    secureStore.setString(KEYS.accessToken, accessToken);
    secureStore.setString(KEYS.refreshToken, refreshToken);
    secureStore.setJSON(KEYS.user, user);
    set({ accessToken, refreshToken, user, status: 'authenticated' });
  },

  setTokens: (accessToken, refreshToken) => {
    secureStore.setString(KEYS.accessToken, accessToken);
    secureStore.setString(KEYS.refreshToken, refreshToken);
    set({ accessToken, refreshToken });
  },

  clearSession: () => {
    secureStore.remove(KEYS.accessToken);
    secureStore.remove(KEYS.refreshToken);
    secureStore.remove(KEYS.user);
    set({
      accessToken: null,
      refreshToken: null,
      user: null,
      status: 'unauthenticated',
    });
  },
}));
