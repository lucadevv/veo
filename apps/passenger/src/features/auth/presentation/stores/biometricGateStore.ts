import {create} from 'zustand';

/**
 * Estado del CANDADO biométrico de re-login (Zustand, en memoria).
 *
 * Política:
 *  - Al rehidratar una sesión persistida en frío (arranque de app), el candado nace BLOQUEADO:
 *    el usuario debe pasar Face ID / huella antes de usar la app (desbloquea el refresh token).
 *  - Tras un login fresco por OTP, se llama `unlock()` (el usuario acaba de autenticarse).
 *  - Al cerrar sesión, se llama `lock()` para que la próxima sesión vuelva a exigir biometría.
 *
 * No persiste: el bloqueo es por proceso, así reaparece en cada arranque en frío.
 */
interface BiometricGateState {
  locked: boolean;
  /** Marca la sesión como desbloqueada (biometría superada o no disponible). */
  unlock: () => void;
  /** Vuelve a bloquear (logout o tras un arranque en frío). */
  lock: () => void;
}

export const useBiometricGateStore = create<BiometricGateState>(set => ({
  locked: true,
  unlock: () => set({locked: false}),
  lock: () => set({locked: true}),
}));
