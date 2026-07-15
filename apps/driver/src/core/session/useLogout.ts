import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useDi, useRepositories } from '../di/useDi';
import { useSessionStore } from './sessionStore';
import { LogoutUseCase } from '../../features/auth/domain';
import { HttpPushRegistrationPort, fcmPushService } from '../../features/notifications/data';

/**
 * Cierre de sesión — hook de ciclo de vida de SESIÓN, no de una feature.
 *
 * Vive en `core/session` (junto a `sessionStore`) porque el logout es cross-feature: lo dispara tanto
 * `ProfileScreen` (botón "Cerrar sesión") como la salida de emergencia del onboarding
 * (`registration/useRegistrationExit`). Antes vivía en `profile/presentation/hooks/useProfile` y
 * `registration` lo importaba cruzando la presentation de profile (violaba el aislamiento del arquetipo).
 * `core` es el composition-root de la app (ya cablea repos de todas las features en `core/di`), así que
 * orquestar aquí `auth/domain` + `notifications/data` + `sessionStore` es coherente con esa capa.
 *
 * Revoca el refresh token en el servidor y limpia el estado local + caché. Si la revocación remota falla
 * (p. ej. sin red), igual se cierra la sesión localmente.
 */
export function useLogout() {
  const { auth } = useRepositories();
  const { localAuth, httpClient } = useDi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // Baja del device token con el JWT aún vigente (antes de revocar/limpiar la sesión).
      await fcmPushService
        .unregisterCurrentToken(new HttpPushRegistrationPort(httpClient))
        .catch(() => undefined);
      const refreshToken = useSessionStore.getState().refreshToken;
      if (refreshToken) {
        try {
          await new LogoutUseCase(auth).execute(refreshToken);
        } catch {
          // El logout local es la prioridad; ignoramos el fallo remoto.
        }
      }
    },
    onSettled: async () => {
      // Elimina el refresh token biométrico para que no quede disponible el re-login.
      await localAuth.clear().catch(() => undefined);
      useSessionStore.getState().clearSession();
      queryClient.clear();
    },
  });
}
