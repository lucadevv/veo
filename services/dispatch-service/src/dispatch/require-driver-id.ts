/**
 * Trust boundary del lado conductor (cierre #9): deriva el driverId de la identidad interna FIRMADA,
 * NUNCA del cliente. El driver-bff firma este driverId (vía GetDriverByUser) en la identidad HMAC; el
 * cliente NO lo puede forjar. Una identidad SIN driverId (passenger/admin) no es un conductor → 403
 * (fail-closed). Fuente ÚNICA del derivador para TODA la superficie DRIVER de dispatch (puja + ofertas)
 * — antes vivía local en offer-board.controller; ahora lo comparten ambos controllers (sin duplicar).
 */
import type { AuthenticatedUser } from '@veo/auth';
import { ForbiddenError } from '@veo/utils';

export function requireDriverId(user: AuthenticatedUser | undefined): string {
  const driverId = user?.driverId;
  if (!driverId) {
    throw new ForbiddenError('Solo un conductor puede operar sobre la oferta', {
      type: user?.type,
    });
  }
  return driverId;
}
