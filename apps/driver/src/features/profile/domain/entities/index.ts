import type {
  DriverOnboardRequest,
  DriverOnboardResult,
  DriverProfileView,
} from '@veo/api-client';

/**
 * Entidades del dominio de perfil del conductor (identity + rating + fleet + compliance).
 */
export type DriverProfile = DriverProfileView;
export type OnboardInput = DriverOnboardRequest;
/** Resultado FINO de `POST /drivers/onboard` (`{ driverId, backgroundCheckStatus }`), NO el perfil agregado. */
export type OnboardResult = DriverOnboardResult;
