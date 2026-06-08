import type {
  PassengerProfile,
  RequestPhoneLinkResult,
  UpdatePassengerProfile,
} from '@veo/api-client';
import type { AccountDeletionRequest } from './entities';

/** Abstracción del repositorio de Perfil del pasajero (DIP). */
export interface ProfileRepository {
  /** GET /users/me → perfil del pasajero autenticado. */
  getMe(): Promise<PassengerProfile>;
  /** PATCH /users/me → actualiza campos del perfil. */
  updateMe(input: UpdatePassengerProfile): Promise<PassengerProfile>;
  /**
   * PATCH /users/me { photoUrl: null } → revierte (quita) la foto persistida en el backend.
   *
   * Endpoint propio idéntico a `updateMe`; método dedicado porque el contrato tipado de
   * `UpdatePassengerProfile` no admite `null` para `photoUrl` (solo `string | undefined`), pero la
   * columna del backend SÍ es anulable y limpiar la foto es una operación legítima del perfil.
   */
  clearAvatar(): Promise<PassengerProfile>;
  /** POST /users/me/deletion → solicita el borrado de cuenta (derecho al olvido). */
  requestDeletion(): Promise<AccountDeletionRequest>;
  /** DELETE /users/me/deletion → cancela la solicitud de borrado dentro del periodo de gracia. */
  cancelDeletion(): Promise<void>;
  /**
   * POST /users/me/phone/request { phone } → { sent } → pide el envío del código de verificación de
   * celular (SMS soberano por SMPP). Para usuarios que entraron por correo/Google/Apple sin teléfono.
   */
  requestPhoneCode(phone: string): Promise<RequestPhoneLinkResult>;
  /**
   * POST /users/me/phone/verify { phone, code } → 200 PassengerProfile (ya con el `phone` poblado).
   * Confirma la posesión del número y lo persiste en el perfil.
   */
  verifyPhone(phone: string, code: string): Promise<PassengerProfile>;
}
