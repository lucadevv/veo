import { create } from 'zustand';
import { prefsStore } from '../../../../core/storage/mmkv';

/**
 * Estado de cliente (Zustand) del perfil del pasajero, CLAVEADO POR `userId`.
 *
 * La FUENTE DE VERDAD del perfil (nombre, correo, foto) es el backend (`GET/PATCH /users/me`); este
 * store solo guarda una señal de UI no sensible en `prefsStore` (MMKV, no el almacén cifrado):
 *  - `profile.completed.<userId>`: bandera optimista de "perfil completado" para ESTE usuario. Evita
 *    re-mostrar `CompleteProfileScreen` justo tras guardar (sin esperar un refetch). Es UNA de las
 *    señales con las que el navegador deriva la completitud; la otra es el `name`/`email` reales del
 *    perfil (ver `useProfileCompletion`). Clavear por `userId` evita atrapar sesiones rehidratadas o
 *    cuentas existentes en el mismo dispositivo.
 */
const completedKey = (userId: string): string => `profile.completed.${userId}`;

interface ProfileLocalState {
  /** `userId` → perfil marcado como completado localmente (reactivo para el navegador). */
  completedByUser: Record<string, boolean>;

  /** Hidrata de forma síncrona la bandera local de un usuario desde MMKV (idempotente). */
  hydrateUser: (userId: string) => void;
  /**
   * Marca el perfil de `userId` como completado (fast-path de UI tras un guardado real en backend).
   * El `RootNavigator` conmuta de stack por estado derivado (no se navega imperativamente).
   */
  markCompleted: (userId: string) => void;
  /** Limpia la bandera local de un usuario (p. ej. cambio de cuenta). */
  resetUser: (userId: string) => void;
}

export const useProfileLocalStore = create<ProfileLocalState>((set, get) => ({
  completedByUser: {},

  hydrateUser: (userId) => {
    // Ya hidratado en esta sesión de proceso: no relee MMKV.
    if (get().completedByUser[userId] !== undefined) {
      return;
    }
    const completed = prefsStore.getBoolean(completedKey(userId)) ?? false;
    set((state) => ({
      completedByUser: { ...state.completedByUser, [userId]: completed },
    }));
  },

  markCompleted: (userId) => {
    prefsStore.setBoolean(completedKey(userId), true);
    set((state) => ({
      completedByUser: { ...state.completedByUser, [userId]: true },
    }));
  },

  resetUser: (userId) => {
    prefsStore.remove(completedKey(userId));
    set((state) => ({
      completedByUser: { ...state.completedByUser, [userId]: false },
    }));
  },
}));
