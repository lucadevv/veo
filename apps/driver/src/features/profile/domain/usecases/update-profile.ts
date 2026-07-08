import type { ProfileRepository } from '../repositories/profile-repository';
import type { PersonalData, UpdatePersonalInput } from '../entities';

/**
 * Caso de uso: actualiza los datos personales (PII) del conductor vía `PATCH /drivers/me/personal`.
 * Delega en la abstracción del repositorio (DIP); la validación de forma la aplica el contrato Zod en
 * la capa de datos (`driverPersonalDataRequest`) y, defensivamente, el DTO del driver-bff.
 *
 * Nota de contrato: el endpoint exige los TRES campos KYC (legalName, dni, birthDate). Hoy `GET
 * /drivers/me` NO devuelve dni ni birthDate, así que `EditProfileScreen` no puede construir un body
 * completo desde el perfil (ver el reporte de la pantalla). El caso de uso queda listo para cuando el
 * perfil exponga esos campos o exista un flujo de edición KYC dedicado.
 */
export class UpdateProfileUseCase {
  constructor(private readonly repository: ProfileRepository) {}

  execute(input: UpdatePersonalInput): Promise<PersonalData> {
    return this.repository.updatePersonal(input);
  }
}
