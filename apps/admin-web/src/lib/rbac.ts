import type { SessionUser } from '@veo/api-client';
import { AdminRole } from '@veo/shared-types';
import { PERMISSION_ROLES, type Permission } from '@veo/policy';

/**
 * RBAC de presentación. Oculta/deshabilita acciones sensibles en la UI según los roles del
 * sessionUser. La AUTORIDAD real es el admin-bff (que vuelve a verificar permisos con sus guards);
 * esto es defensa en profundidad para la experiencia, no el control de seguridad final.
 *
 * La matriz base `PERMISSION_ROLES` (capa 1 del gobierno unificado · ADR-025 §0/§1) ahora vive en
 * `@veo/policy` — FUENTE ÚNICA front+backend: el mismo mapa que la UI usa para ocultar es el que
 * identity-service usa para enforcear el invariante subtract-only del Overlay. Acá se re-exporta para
 * no romper los imports existentes (`import { Permission, PERMISSION_ROLES } from '@/lib/rbac'`).
 */
export type { Permission };
export { PERMISSION_ROLES };

/**
 * ¿El usuario puede ver/usar `permission`? Compone las DOS capas del gobierno unificado (ADR-025):
 *   base ∧ ¬oculto
 * donde `base` = la matriz `PERMISSION_ROLES` (capa 1) le concede el permiso a alguno de sus roles, y `¬oculto`
 * = el OVERLAY (capa 2) NO se lo RESTÓ (`hiddenPermissions`, computado server-side con la MISMA fórmula que el
 * `PermissionOverlayGuard`). Así un permiso restado desaparece de la UI (nav/botones/páginas), no solo lo bloquea
 * el server. `hiddenPermissions` ausente (sesión vieja / sin overrides) → rige la base pura (fail-safe).
 * Todos los helpers de abajo (`permissionsOf`, `nav`, gates de página) heredan esta composición vía `can()`.
 */
export function can(user: SessionUser | null | undefined, permission: Permission): boolean {
  if (!user) return false;
  const allowed = PERMISSION_ROLES[permission] as readonly string[];
  const grantedByBase = user.roles.some((role) => allowed.includes(role));
  return grantedByBase && !user.hiddenPermissions?.includes(permission);
}

/** Conjunto de permisos efectivos del usuario (unión de los permisos que conceden sus roles). */
export function permissionsOf(user: SessionUser | null | undefined): Set<Permission> {
  const set = new Set<Permission>();
  if (!user) return set;
  for (const permission of Object.keys(PERMISSION_ROLES) as Permission[]) {
    if (can(user, permission)) set.add(permission);
  }
  return set;
}

export function hasRole(user: SessionUser | null | undefined, role: AdminRole): boolean {
  return user?.roles.includes(role) ?? false;
}

/** Las acciones de video exigen MFA fresco (step-up) además del permiso. */
export function canAccessMedia(user: SessionUser | null | undefined): boolean {
  return can(user, 'media:view') || can(user, 'media:approve');
}
