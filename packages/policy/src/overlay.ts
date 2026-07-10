/**
 * Overlay de visibilidad de permisos (ADR-025 §3) — la CAPA 2 del gobierno unificado.
 *
 * Registro SUBTRACT-ONLY: el superadmin RESTA un permiso a un rol. NO concede jamás. El permiso EFECTIVO
 * de un rol = `base(rol, permiso)` **AND NOT** `override.hidden`. `@veo/policy` NO conoce la matriz base
 * (esa vive en los `@Roles` de los controllers y en `PERMISSION_ROLES` de admin-web/rbac.ts); acá solo se
 * provee la mitad editable: "¿este par (rol, permiso) está RESTADO (hidden)?". El caller compone con la base.
 *
 * Mismo molde que las Políticas (ADR-024): tabla versionada en identity (módulo `gobierno`) → PUT admin-gated
 * → outbox + audit WORM → distribución por Kafka (`permission_override.updated`) → consumo cacheado acá con
 * DEFAULT fail-safe (ausencia = NO restado = rige la base; nunca se resta por un fallo de lectura).
 */

/**
 * Un par (rol, permiso) RESTADO por el superadmin. `role` se tipa como `string` (no `AdminRole` de
 * `@veo/shared-types`) para no acoplar el contrato liviano a ese paquete y para casar 1:1 con el wire
 * (el modelo Prisma `PermissionOverride` guarda `String`, el evento viaja como `z.string()`): el rol
 * canónico es un `AdminRole`, pero acá se transporta como su string. `hidden=true` = restado; una fila
 * con `hidden=false` es un des-restaurado explícito (equivale a la ausencia de fila → rige la base).
 */
export interface PermissionOverride {
  /** Rol al que se le resta el permiso (un `AdminRole` de `@veo/shared-types`, transportado como string). */
  role: string;
  /** Permiso restado (ej. 'drivers:approve', 'ops:view'). */
  permission: string;
  /** subtract-only: `true` = RESTADO a ese rol; `false` = des-restaurado (rige la base). */
  hidden: boolean;
}

/** Clave de cache/índice de un override: `role|permission`. Un solo punto para no divergir el keying. */
export function overrideKey(role: string, permission: string): string {
  return `${role}|${permission}`;
}
