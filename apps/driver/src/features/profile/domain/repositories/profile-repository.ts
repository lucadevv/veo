import type {
  DeletionRequested,
  DriverProfile,
  OnboardInput,
  OnboardResult,
  PersonalData,
  PhoneChanged,
  UpdatePersonalInput,
} from '../entities';

/**
 * Contrato del repositorio de perfil (capa domain). Implementación concreta en `data/`.
 */
export interface ProfileRepository {
  /** GET /drivers/me — perfil agregado del conductor autenticado. */
  getMe(): Promise<DriverProfile>;
  /** POST /drivers/onboard — registra datos de licencia (onboarding); devuelve el perfil FINO. */
  onboard(input: OnboardInput): Promise<OnboardResult>;
  /** PATCH /drivers/me/personal — actualiza los datos personales (PII) del conductor. */
  updatePersonal(input: UpdatePersonalInput): Promise<PersonalData>;
  /** POST /drivers/me/phone/request — pide el OTP por SMS al número NUEVO (cambio de teléfono). */
  requestPhoneChange(phone: string): Promise<void>;
  /** POST /drivers/me/phone/verify — verifica el OTP y vincula el número NUEVO (nuevo login). */
  verifyPhoneChange(phone: string, code: string): Promise<PhoneChanged>;
  /** POST /drivers/me/deletion — solicita el borrado de cuenta (derecho al olvido, gracia 30 días). */
  requestDeletion(): Promise<DeletionRequested>;
}
