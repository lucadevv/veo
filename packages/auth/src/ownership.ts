/**
 * Verificación de PROPIEDAD (anti-IDOR) para lecturas de un microservicio.
 *
 * Contexto: el BFF resuelve el driverId (userId→driver vía identity) y lo firma en la identidad
 * interna (HMAC) — ver `AuthenticatedUser.driverId` e `internal-identity.ts`. Los servicios NO
 * deben confiar en un driverId arbitrario del query param: deben verificar que pertenece al
 * llamante autenticado.
 *
 * Regla:
 *  - Identidad de tipo 'driver': el driverId pedido DEBE coincidir con el driverId firmado.
 *    Si la identidad no trae driverId firmado (BFF antiguo / falta resolverlo) → 403, fail-closed.
 *  - Identidades NO 'driver' (admin/finance vía admin-bff, etc.): pasan; su autorización se gobierna
 *    por RBAC en su propio camino (RolesGuard). Esta verificación es específica del riesgo
 *    driver↔driver.
 */
import { ForbiddenError } from '@veo/utils';
import type { AuthenticatedUser } from './jwt.js';

/**
 * Lanza ForbiddenError (403) si una identidad de conductor intenta leer un recurso de otro
 * conductor. No-op para identidades que no son de tipo 'driver'.
 *
 * @param user identidad autenticada (de la identidad interna firmada)
 * @param requestedDriverId driverId solicitado en el query/param
 */
export function assertDriverOwnsResource(
  user: AuthenticatedUser | undefined,
  requestedDriverId: string,
): void {
  if (!user) throw new ForbiddenError('Identidad ausente');
  if (user.type !== 'driver') return;
  if (!user.driverId || user.driverId !== requestedDriverId) {
    throw new ForbiddenError('No autorizado a acceder a recursos de otro conductor');
  }
}
