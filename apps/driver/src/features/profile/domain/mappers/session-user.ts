import type {MobileSessionUser} from '@veo/api-client';
import type {DriverProfile} from '../entities';

/**
 * Proyecta el perfil agregado del conductor al usuario mínimo de sesión (`MobileSessionUser`).
 * Cubre el hueco del contrato: `POST /auth/otp/verify` no devuelve `user`, así que la sesión se
 * compone a partir de `GET /drivers/me`.
 */
export function profileToSessionUser(profile: DriverProfile): MobileSessionUser {
  return {
    id: profile.userId,
    phone: profile.phone,
    type: 'driver',
    kycStatus: profile.kycStatus,
  };
}
