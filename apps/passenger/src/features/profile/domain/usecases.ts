import type {
  PassengerProfile,
  RequestPhoneLinkResult,
  UpdatePassengerProfile,
} from '@veo/api-client';
import type { AuthRepository } from '../../auth/domain/authRepository';
import type { AvatarUploader } from '../../../shared/media/domain/avatarUploader';
import type { PickedImage } from '../../../shared/media/domain/imagePickerService';
import type { AccountDeletionRequest } from './entities';
import type { ProfileRepository } from './profileRepository';
import { isPeruMobileValid } from './phoneVerification';

/** Error de validación local del celular ANTES de tocar la red (se enruta a la UI del sheet). */
export class PhoneValidationError extends Error {
  constructor(message = 'INVALID_PHONE') {
    super(message);
    this.name = 'PhoneValidationError';
  }
}

/** Obtiene el perfil del pasajero autenticado. */
export class GetProfileUseCase {
  constructor(private readonly repository: ProfileRepository) {}

  execute(): Promise<PassengerProfile> {
    return this.repository.getMe();
  }
}

/** Actualiza el perfil (email/foto). */
export class UpdateProfileUseCase {
  constructor(private readonly repository: ProfileRepository) {}

  execute(input: UpdatePassengerProfile): Promise<PassengerProfile> {
    return this.repository.updateMe(input);
  }
}

/**
 * Sube el avatar elegido y persiste la `photoUrl` resultante en el perfil del pasajero.
 *
 * Orquesta dos colaboradores (DIP): el puerto `AvatarUploader` (subida prefirmada a S3/MinIO) y el
 * `ProfileRepository` (`PATCH /users/me`). Devuelve el perfil ya actualizado para que la
 * presentación pueda refrescar su caché sin un refetch adicional. Toda la lógica de red vive aquí;
 * la pantalla solo dispara el caso de uso.
 */
export class UploadAvatarUseCase {
  constructor(
    private readonly uploader: AvatarUploader,
    private readonly repository: ProfileRepository,
  ) {}

  async execute(file: PickedImage): Promise<PassengerProfile> {
    const { photoUrl } = await this.uploader.uploadAvatar(file);
    return this.repository.updateMe({ photoUrl });
  }
}

/**
 * Quita (revierte) la foto de avatar ya persistida en el backend.
 *
 * Se usa cuando el usuario, tras una subida EXITOSA (la `photoUrl` ya quedó guardada vía
 * `PATCH /users/me`), elige "Quitar foto": limpiar solo la UI local dejaría la foto huérfana en el
 * servidor. Este caso de uso dispara `PATCH /users/me { photoUrl: null }` y devuelve el perfil
 * actualizado para refrescar la caché sin un refetch.
 */
export class RemoveAvatarUseCase {
  constructor(private readonly repository: ProfileRepository) {}

  execute(): Promise<PassengerProfile> {
    return this.repository.clearAvatar();
  }
}

/**
 * Pide el envío del código de verificación al celular del pasajero (SMS soberano). Valida la forma
 * del número LOCALMENTE antes de tocar la red (throw `PhoneValidationError` → la UI lo enruta a un
 * error de campo, sin disparar el POST).
 */
export class RequestPhoneCodeUseCase {
  constructor(private readonly repository: ProfileRepository) {}

  execute(phone: string): Promise<RequestPhoneLinkResult> {
    const trimmed = phone.trim();
    if (!isPeruMobileValid(trimmed)) {
      return Promise.reject(new PhoneValidationError());
    }
    return this.repository.requestPhoneCode(trimmed);
  }
}

/**
 * Verifica el código recibido por SMS y persiste el celular en el perfil. Devuelve el perfil ya
 * actualizado (con `phone`) para refrescar la caché sin un refetch. Valida la forma localmente.
 */
export class VerifyPhoneUseCase {
  constructor(private readonly repository: ProfileRepository) {}

  execute(phone: string, code: string): Promise<PassengerProfile> {
    const trimmedPhone = phone.trim();
    const trimmedCode = code.trim();
    if (!isPeruMobileValid(trimmedPhone) || !/^\d{6}$/.test(trimmedCode)) {
      return Promise.reject(new PhoneValidationError());
    }
    return this.repository.verifyPhone(trimmedPhone, trimmedCode);
  }
}

/** Solicita el borrado de cuenta (derecho al olvido, Ley N.° 29733). */
export class RequestAccountDeletionUseCase {
  constructor(private readonly repository: ProfileRepository) {}

  execute(): Promise<AccountDeletionRequest> {
    return this.repository.requestDeletion();
  }
}

/**
 * Cierra sesión en el servidor (revoca el refresh token). El borrado del estado local de sesión lo
 * realiza la capa de presentación tras este caso de uso (incluso si la llamada remota falla).
 */
export class LogoutUseCase {
  constructor(private readonly repository: AuthRepository) {}

  async execute(refreshToken: string | null): Promise<void> {
    if (!refreshToken) {
      return;
    }
    try {
      await this.repository.logout(refreshToken);
    } catch {
      // Logout remoto best-effort: el cierre local siempre procede.
    }
  }
}
