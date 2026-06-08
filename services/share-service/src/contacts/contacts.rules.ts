/**
 * Reglas de dominio puras de los contactos de confianza (BR-I06). Sin I/O → unit-testables.
 */
import { ConflictError } from '@veo/utils';

/** Máximo de contactos de confianza por usuario (BR-I06). */
export const DEFAULT_MAX_TRUSTED_CONTACTS = 3;

/** Lanza si el usuario ya alcanzó el cupo máximo de contactos. */
export function assertContactQuota(currentCount: number, max: number): void {
  if (currentCount >= max) {
    throw new ConflictError(`Solo puedes registrar hasta ${max} contactos de confianza`, {
      currentCount,
      max,
    });
  }
}

/**
 * Cool-down de modificación de la lista (BR-I06): no se puede cambiar la lista antes de `cooldownMs`
 * desde la última modificación. `lastModifiedAt` null = nunca se modificó (permitido).
 */
export function assertContactsCooldown(
  lastModifiedAt: Date | null,
  cooldownMs: number,
  now = Date.now(),
): void {
  if (!lastModifiedAt) return;
  const elapsed = now - lastModifiedAt.getTime();
  if (elapsed < cooldownMs) {
    const hoursLeft = Math.ceil((cooldownMs - elapsed) / 3_600_000);
    throw new ConflictError(
      `Por seguridad solo puedes modificar tus contactos cada ${Math.round(cooldownMs / 3_600_000)}h. Inténtalo en ~${hoursLeft}h.`,
      { retryInHours: hoursLeft },
    );
  }
}
