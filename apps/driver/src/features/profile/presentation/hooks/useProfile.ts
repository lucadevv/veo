import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAvatarUploader, useRepositories } from '../../../../core/di/useDi';
import { useSessionStore } from '../../../../core/session/sessionStore';
import {
  GetProfileUseCase,
  PROFILE_QUERY_KEY,
  UpdateProfileUseCase,
  UploadAvatarUseCase,
  profileToSessionUser,
  type UpdatePersonalInput,
} from '../../domain';
import type { PickedImage } from '../../../documents/domain/ports/image-picker-service';

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
