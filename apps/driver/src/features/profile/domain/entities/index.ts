import type {
  DriverOnboardRequest,
  DriverOnboardResult,
  DriverPersonalData,
  DriverPersonalDataRequest,
  DriverProfileView,
} from '@veo/api-client';

/**
 * Entidades del dominio de perfil del conductor (identity + rating + fleet + compliance).
 */
export type DriverProfile = DriverProfileView;
export type OnboardInput = DriverOnboardRequest;
/** Resultado FINO de `POST /drivers/onboard` (`{ driverId, backgroundCheckStatus }`), NO el perfil agregado. */
export type OnboardResult = DriverOnboardResult;

/**
 * Body de `PATCH /drivers/me/personal` (PII · legalName + dni + birthDate, los TRES obligatorios en el
 * contrato). Es la ÚNICA mutación de datos personales que expone el driver-bff hoy — no hay endpoint
 * para teléfono ni correo (ver EditProfileScreen).
 */
export type UpdatePersonalInput = DriverPersonalDataRequest;
/** Vista de datos personales que devuelve `PATCH /drivers/me/personal` (campos nullables). */
export type PersonalData = DriverPersonalData;
