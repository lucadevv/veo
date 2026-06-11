/**
 * Identidades sintéticas internas del BFF.
 *  - ANONYMOUS: para el passthrough de los endpoints públicos de auth (el downstream los marca
 *    @Public y NO valida la identidad; el header firmado se ignora, pero el cliente REST lo exige).
 *  - SYSTEM: para lecturas gRPC que dispara el consumidor Kafka (sin usuario en contexto).
 */
import { anonymousIdentity, type AuthenticatedUser } from '@veo/auth';

/**
 * Sabor driver de la identidad anónima canónica (@veo/auth `anonymousIdentity`): la FORMA vive una
 * sola vez allá. `sessionId` pasa de 'anonymous' a '' (la convención canónica: vacío = sin sesión);
 * el downstream ignora la identidad en estos passthroughs @Public, así que no cambia semántica.
 */
export const ANONYMOUS_DRIVER_IDENTITY: AuthenticatedUser = anonymousIdentity('driver');

export const SYSTEM_IDENTITY: AuthenticatedUser = {
  userId: 'driver-bff-system',
  type: 'driver',
  roles: [],
  sessionId: 'system',
};
