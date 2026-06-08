import type {DriverOnboardRequest, DriverProfileView} from '@veo/api-client';

/**
 * Entidades del dominio de perfil del conductor (identity + rating + fleet + compliance).
 */
export type DriverProfile = DriverProfileView;
export type OnboardInput = DriverOnboardRequest;
