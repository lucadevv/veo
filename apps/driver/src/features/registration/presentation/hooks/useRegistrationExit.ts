import { useCallback, useState } from 'react';
import { useLogout } from '../../../../core/session/useLogout';

/**
 * Salida de emergencia del onboarding (LOTE 1). Encapsula el ÚNICO camino de salida de las pantallas
 * pre-aprobación (paso 1 del wizard, "En revisión", "Rechazado" y el reintento del gate): pide
 * confirmación y, al confirmar, ejecuta el MISMO `useLogout` del perfil (revoca el refresh token,
 * limpia tokens del secureStore y resetea el alta en MMKV vía `clearSession`). NO duplica la lógica de
 * limpieza de sesión: reusa el usecase existente.
 *
 * Devuelve la maquinaria del confirm (estado + acciones) para que cada pantalla pinte el diálogo con
 * el patrón `BottomSheet` de `@veo/ui-kit` que ya usa `ProfileScreen` (coherencia visual). El render se
 * deja a la pantalla (no a un componente acá) para no acoplar el hook a la UI ni a sus textos i18n.
 */
export interface RegistrationExit {
  /** true cuando el diálogo de confirmación de salida está abierto. */
  confirmVisible: boolean;
  /** Abre el confirm de salida (lo dispara el botón "Salir" o el back de hardware). */
  requestExit: () => void;
  /** Cierra el confirm sin salir (cancelar). */
  dismissExit: () => void;
  /** Confirma la salida: cierra el sheet y ejecuta el logout/clearSession reusado. */
  confirmExit: () => void;
  /**
   * Handler único para el back de hardware de Android. Encapsula la decisión: si el confirm está
   * abierto lo CIERRA (dismiss, comportamiento esperado de "atrás"), si está cerrado lo ABRE (request).
   * La pantalla/guard no decide nada: solo lo invoca. Pensado para pasarlo a `useRegistrationExitGuard`.
   */
  handleHardwareBack: () => void;
  /** true mientras corre la mutación de logout (para el estado de carga del botón). */
  isLoggingOut: boolean;
}

export function useRegistrationExit(): RegistrationExit {
  const logout = useLogout();
  const [confirmVisible, setConfirmVisible] = useState(false);

  const requestExit = useCallback(() => {
    setConfirmVisible(true);
  }, []);

  const dismissExit = useCallback(() => {
    setConfirmVisible(false);
  }, []);

  const confirmExit = useCallback(() => {
    setConfirmVisible(false);
    // `mutate` es fire-and-forget por diseño (la mutación maneja sus propios errores en onSettled):
    // no hay promesa flotante porque `useMutation.mutate` no devuelve una promesa.
    logout.mutate();
  }, [logout]);

  const handleHardwareBack = useCallback(() => {
    // Decisión centralizada acá (SRP): si el sheet ya está abierto, el back lo CIERRA (dismiss);
    // si está cerrado, lo ABRE (request). El guard se mantiene tonto: solo consume el evento.
    setConfirmVisible((visible) => !visible);
  }, []);

  return {
    confirmVisible,
    requestExit,
    dismissExit,
    confirmExit,
    handleHardwareBack,
    isLoggingOut: logout.isPending,
  };
}
