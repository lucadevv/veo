import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAvatarUploader, useDi, useRepositories } from '../../../../core/di/useDi';
import { useSessionStore } from '../../../../core/session/sessionStore';
import {
  GetProfileUseCase,
  UpdateProfileUseCase,
  UploadAvatarUseCase,
  profileToSessionUser,
  type UpdatePersonalInput,
} from '../../domain';
import type { PickedImage } from '../../../documents/domain/ports/image-picker-service';
import { LogoutUseCase } from '../../../auth/domain';
import { HttpPushRegistrationPort, fcmPushService } from '../../../notifications/data';

/** Clave de caché del perfil del conductor. */
export const PROFILE_QUERY_KEY = ['profile', 'me'] as const;

/** Query: perfil agregado del conductor (identity + rating + fleet + compliance). */
export function useProfile() {
  const { profile } = useRepositories();
  return useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: async () => {
      const data = await new GetProfileUseCase(profile).execute();
      // Mantiene el usuario de sesión sincronizado con el perfil más reciente.
      useSessionStore.getState().setUser(profileToSessionUser(data));
      return data;
    },
  });
}

/**
 * Mutación: actualiza los datos personales (PII) del conductor (`PATCH /drivers/me/personal`) e
 * invalida el query del perfil para refrescar la vista con el dato persistido.
 */
export function useUpdateProfile() {
  const { profile } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePersonalInput) => new UpdateProfileUseCase(profile).execute(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY }),
  });
}

/**
 * Mutación: sube la foto de perfil (avatar) elegida (presign → PUT → confirm; el confirm del driver-bff
 * persiste la foto en el perfil) e invalida el query del perfil para refrescar la vista con la foto nueva.
 */
export function useUploadAvatar() {
  const uploader = useAvatarUploader();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: PickedImage) => new UploadAvatarUseCase(uploader).execute(file),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY }),
  });
}

/**
 * Mutación de logout: revoca el refresh token en el servidor y limpia el estado local + caché.
 * Si la revocación remota falla (p. ej. sin red), igual se cierra la sesión localmente.
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
