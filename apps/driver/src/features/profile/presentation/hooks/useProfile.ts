import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAvatarUploader, useRepositories } from '../../../../core/di/useDi';
import { useSessionStore } from '../../../../core/session/sessionStore';
import {
  GetProfileUseCase,
  PROFILE_QUERY_KEY,
  RequestAccountDeletionUseCase,
  RequestPhoneChangeUseCase,
  UpdateProfileUseCase,
  UploadAvatarUseCase,
  VerifyPhoneChangeUseCase,
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

/**
 * Mutación: pide el OTP del CAMBIO de número (`POST /drivers/me/phone/request`). El código va por
 * SMS al número NUEVO (semántica del dueño); la validación local del formato vive en el use case.
 */
export function useRequestPhoneChange() {
  const { profile } = useRepositories();
  return useMutation({
    mutationFn: (phone: string) => new RequestPhoneChangeUseCase(profile).execute(phone),
  });
}

/**
 * Mutación: verifica el OTP y vincula el número NUEVO (`POST /drivers/me/phone/verify`), que pasa a
 * ser el teléfono de LOGIN. Invalida el perfil para que la pantalla muestre el dato persistido.
 */
export function useVerifyPhoneChange() {
  const { profile } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ phone, code }: { phone: string; code: string }) =>
      new VerifyPhoneChangeUseCase(profile).execute(phone, code),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY }),
  });
}

/**
 * Mutación: solicita el borrado de cuenta (derecho al olvido, Ley N.° 29733) vía
 * `POST /drivers/me/deletion`. Devuelve `graceUntil`; el flujo de la pantalla informa la gracia y
 * cierra la sesión (espejo del pasajero).
 */
export function useRequestAccountDeletion() {
  const { profile } = useRepositories();
  return useMutation({
    mutationFn: () => new RequestAccountDeletionUseCase(profile).execute(),
  });
}
