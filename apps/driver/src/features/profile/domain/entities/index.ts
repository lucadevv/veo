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

/**
 * Respuesta 202 de `POST /drivers/me/deletion` (derecho al olvido, Ley 29733): identity registró la
 * solicitud y arranca la gracia; `graceUntil` es la fecha ISO hasta la que se puede cancelar.
 */
export interface DeletionRequested {
  graceUntil: string;
}

/**
 * Respuesta de `POST /drivers/me/phone/verify`: el número NUEVO quedó vinculado y desde ahora es el
 * teléfono de LOGIN del conductor (semántica del dueño; el BFF proyecta el perfil de identity a esto).
 */
export interface PhoneChanged {
  phone: string | null;
}
