import {create} from 'zustand';
import type {MobileSessionUser} from '@veo/api-client';
import {prefsStore, secureStore} from '../storage/mmkv';
import {SecureKey} from '../storage/keys';

/**
 * Clave de preferencias donde el wizard de alta persiste su progreso (espeja la constante del
 * `registrationStore`). Se borra en logout/expiración para que no haya fuga de PII entre conductores
 * y para que el siguiente conductor NO herede un `status` (p. ej. `approved`) ni el flag
 * `statusResolvedFromBackend` de la cuenta anterior.
 */
const REGISTRATION_PREF_KEY = 'pref.registration.v1';

/**
 * Resetea el estado del alta al cerrar/expirar la sesión. SEGURIDAD: sin esto, el store de registro
 * (que vive en memoria + MMKV de preferencias) sobrevive al logout y el siguiente conductor podría
 * (a) ver PII del anterior o (b) entrar a las tabs sin aprobación porque heredó `status: 'approved'`.
 *
 * Se importa el store de forma perezosa (`require` dentro de la función) para no acoplar la capa
 * `core` al feature en tiempo de evaluación de módulo (evita ciclos y la lectura de MMKV al cargar).
 * `reset()` ya borra la clave persistida; además la removemos explícitamente como defensa en
 * profundidad por si la constante del feature divergiera en el futuro.
 */
function resetRegistration(): void {
   
  const {useRegistrationStore} =
    require('../../features/registration/presentation/state/registrationStore') as typeof import('../../features/registration/presentation/state/registrationStore');
  useRegistrationStore.getState().reset();
  prefsStore.remove(REGISTRATION_PREF_KEY);
}

/** Estado del ciclo de vida de la sesión del conductor. */
export type SessionStatus = 'bootstrapping' | 'authenticated' | 'unauthenticated';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

export interface SessionState {
  status: SessionStatus;
  accessToken: string | null;
  refreshToken: string | null;
  user: MobileSessionUser | null;
  /** true si la última pérdida de sesión fue por expiración (no por logout explícito). */
  expired: boolean;
  /** Rehidrata tokens/usuario desde el almacén cifrado al arrancar la app. */
  hydrate(): void;
  /** Establece sesión completa tras verificar OTP (tokens + usuario). */
  setSession(payload: {tokens: SessionTokens; user: MobileSessionUser}): void;
  /** Actualiza solo los tokens (usado por el refresh del cliente HTTP). */
  setTokens(tokens: SessionTokens): void;
  /** Actualiza el usuario de sesión (p. ej. tras refrescar el perfil del conductor). */
  setUser(user: MobileSessionUser): void;
  /** Limpia la sesión por logout explícito del conductor. */
  clearSession(): void;
  /** Limpia la sesión por expiración (refresh fallido): marca `expired` para la pantalla de re-login. */
  expireSession(): void;
}

/**
 * Store de sesión (Zustand): única fuente de verdad del estado de auth en la app.
 * Los tokens se persisten en el almacén MMKV cifrado; el estado en memoria refleja lo persistido.
 * Se consume desde React con `useSessionStore(...)` y fuera de React con `useSessionStore.getState()`.
 */
export const useSessionStore = create<SessionState>(set => ({
  status: 'bootstrapping',
  accessToken: null,
  refreshToken: null,
  user: null,
  expired: false,

  hydrate: () => {
    const accessToken = secureStore.getString(SecureKey.AccessToken) ?? null;
    const refreshToken = secureStore.getString(SecureKey.RefreshToken) ?? null;
    const user = secureStore.getObject<MobileSessionUser>(SecureKey.SessionUser) ?? null;
    set({
      accessToken,
      refreshToken,
      user,
      expired: false,
      status: accessToken ? 'authenticated' : 'unauthenticated',
    });
  },

  setSession: ({tokens, user}) => {
    secureStore.setString(SecureKey.AccessToken, tokens.accessToken);
    secureStore.setString(SecureKey.RefreshToken, tokens.refreshToken);
    secureStore.setObject(SecureKey.SessionUser, user);
    set({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user,
      expired: false,
      status: 'authenticated',
    });
  },

  setTokens: tokens => {
    secureStore.setString(SecureKey.AccessToken, tokens.accessToken);
    secureStore.setString(SecureKey.RefreshToken, tokens.refreshToken);
    set({accessToken: tokens.accessToken, refreshToken: tokens.refreshToken});
  },

  setUser: user => {
    secureStore.setObject(SecureKey.SessionUser, user);
    set({user});
  },

  clearSession: () => {
    secureStore.remove(SecureKey.AccessToken);
    secureStore.remove(SecureKey.RefreshToken);
    secureStore.remove(SecureKey.SessionUser);
    // Limpia el alta para que el siguiente conductor arranque limpio (sin PII ni status heredados).
    resetRegistration();
    set({accessToken: null, refreshToken: null, user: null, expired: false, status: 'unauthenticated'});
  },

  expireSession: () => {
    secureStore.remove(SecureKey.AccessToken);
    secureStore.remove(SecureKey.RefreshToken);
    secureStore.remove(SecureKey.SessionUser);
    // También en expiración: una sesión expirada no debe dejar el progreso del alta accesible.
    resetRegistration();
    set({accessToken: null, refreshToken: null, user: null, expired: true, status: 'unauthenticated'});
  },
}));
