/**
 * SCOPING DE MODERACIÓN POR RIEL (anti-IDOR · fuga de moderación H8) — PUNTO DE DECISIÓN ÚNICO.
 *
 * `flagged`/`flagReason` son el estado de MODERACIÓN del conductor (revisión/suspensión) — NO reputación
 * pública. Solo deben verlos:
 *  - DRIVER_RAIL: el PROPIO conductor sobre SU record (driver-bff pasa su driver.id derivado de la
 *    identidad autenticada) — transparencia, no IDOR.
 *  - ADMIN_RAIL: la revisión del operador.
 * El PUBLIC_RAIL (pasajero, cualquier subjectId) y el SERVICE_RAIL (dispatch, solo scorea avg/count) NO
 * deben verlos: un pasajero pidiendo el agregado de cualquier conductor ENUMERARÍA su estado de moderación.
 *
 * Este módulo es la ÚNICA fuente de esa decisión: lo consumen TANTO el controlador gRPC (GetAggregate) como
 * el REST (GET /ratings/aggregate/:subjectId). Sin clones del `aud === DRIVER || ADMIN` regados por el código.
 *
 * NOTA (defensa en profundidad subject==caller en DRIVER_RAIL): NO se implementa acá — requiere un mapeo
 * userId→driverId cross-service en el hot-path; el driver-bff ya garantiza self-only al derivar el subjectId
 * de la identidad autenticada del conductor. Este helper acota POR RIEL, que es la frontera correcta server-side.
 */
import { InternalAudience } from '@veo/auth';
import type { AggregateEntity } from '../ratings.service';

/**
 * ¿El riel emisor puede VER el estado de moderación (`flagged`/`flagReason`)? Solo DRIVER/ADMIN.
 * PUBLIC/SERVICE y cualquier riel ausente → false (fail-closed). Tipado por `InternalAudience` (cero strings mágicos).
 */
export function exposeModerationFor(aud: InternalAudience | undefined): boolean {
  return aud === InternalAudience.DRIVER_RAIL || aud === InternalAudience.ADMIN_RAIL;
}

/**
 * Devuelve el agregado con la MODERACIÓN acotada al riel: si el riel NO puede verla, `flagged` se fuerza a
 * `false` y `flagReason` a `null` (default honesto: "no expuesto"). La reputación pública (avg/count/role/…)
 * viaja SIEMPRE intacta. No muta el agregado de entrada — devuelve una copia scopeada.
 */
export function scopeAggregateForRail(
  agg: AggregateEntity,
  aud: InternalAudience | undefined,
): AggregateEntity {
  if (exposeModerationFor(aud)) return agg;
  return { ...agg, flagged: false, flagReason: null };
}
