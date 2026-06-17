import { create } from 'zustand';
import { prefsStore } from '../../../../core/storage/mmkv';

/** Clave de preferencias para recordar que el conductor ya vio el onboarding. */
const ONBOARDING_PREF_KEY = 'pref.onboardingCompleted.v1';

export interface OnboardingState {
  /** true si el conductor ya completó (o saltó) el onboarding. */
  completed: boolean;
  /** Marca el onboarding como completado y lo persiste. */
  complete(): void;
}

/**
 * Store de onboarding (Zustand): recuerda si el conductor ya vio el carrusel de bienvenida. Se
 * persiste en MMKV (preferencias, no sensible) para que solo se muestre la primera vez. El
 * `RootNavigator` conmuta por este flag antes del Login para quien no lo ha visto.
 */
export const useOnboardingStore = create<OnboardingState>((set) => ({
  completed: prefsStore.getString(ONBOARDING_PREF_KEY) === 'true',
  complete: () => {
    prefsStore.setString(ONBOARDING_PREF_KEY, 'true');
    set({ completed: true });
  },
}));
