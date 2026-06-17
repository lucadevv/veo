import type { DriverProfile, OnboardInput } from '../entities';

/**
 * Contrato del repositorio de perfil (capa domain). Implementación concreta en `data/`.
 */
export interface ProfileRepository {
  /** GET /drivers/me — perfil agregado del conductor autenticado. */
  getMe(): Promise<DriverProfile>;
  /** POST /drivers/onboard — registra datos de licencia (onboarding). */
  onboard(input: OnboardInput): Promise<DriverProfile>;
}
