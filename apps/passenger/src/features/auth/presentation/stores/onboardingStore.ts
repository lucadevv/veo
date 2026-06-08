import { create } from 'zustand';
import { prefsStore } from '../../../../core/storage/mmkv';

/** Clave de preferencia: onboarding completado (no es dato sensible). */
const KEY = 'onboarding.completed';

interface OnboardingState {
  completed: boolean;
  /** Marca el onboarding como completado y lo persiste. */
  complete: () => void;
}

/**
 * Estado de cliente del onboarding (Zustand). Persiste en el almacén de preferencias (no sensible).
 * Se hidrata de forma síncrona al crear el store (MMKV es lectura instantánea).
 */
export const useOnboardingStore = create<OnboardingState>((set) => ({
  completed: prefsStore.getBoolean(KEY) ?? false,
  complete: () => {
    prefsStore.setBoolean(KEY, true);
    set({ completed: true });
  },
}));
