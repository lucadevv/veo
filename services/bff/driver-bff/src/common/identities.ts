/**
 * Identidades sintéticas internas del BFF.
 *  - ANONYMOUS: para el passthrough de los endpoints públicos de auth (el downstream los marca
 *    @Public y NO valida la identidad; el header firmado se ignora, pero el cliente REST lo exige).
 *  - SYSTEM: para lecturas gRPC que dispara el consumidor Kafka (sin usuario en contexto).
 */
import type { AuthenticatedUser } from '@veo/auth';

export const ANONYMOUS_DRIVER_IDENTITY: AuthenticatedUser = {
  userId: 'anonymous',
  type: 'driver',
  roles: [],
  sessionId: 'anonymous',
};

export const SYSTEM_IDENTITY: AuthenticatedUser = {
  userId: 'driver-bff-system',
  type: 'driver',
  roles: [],
  sessionId: 'system',
};
