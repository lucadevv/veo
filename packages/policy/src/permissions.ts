/**
 * Matriz de PERMISOS BASE (ADR-025 §0/§1 · la CAPA 1 del gobierno unificado).
 *
 * "Qué puede cada rol" es CÓDIGO (candado de seguridad · ADR-025 §1): un cambio de base tiene impacto de
 * seguridad y pasa por PR + review, NUNCA por runtime. Este módulo es la FUENTE ÚNICA de esa matriz para
 * FRONT y BACKEND — antes vivía solo en `apps/admin-web/src/lib/rbac.ts`, invisible para el server. Al
 * unificarla acá (el paquete-contrato de gobierno, ya consumido por identity-service, admin-bff y admin-web):
 *   • el front `rbac.ts` la re-consume (compone `base ∧ ¬override` en la UI),
 *   • identity-service la usa para ENFORCEAR el invariante subtract-only del Overlay (ADR-025 §3): un override
 *     solo puede RESTAR un par (rol, permiso) que la base YA concede — jamás conceder de más.
 *
 * `PERMISSION_ROLES` es un ESPEJO EXACTO de los `@Roles` declarados en cada controller del admin-bff. Si el
 * servidor lo negaría, la base lo refleja. Roles canónicos = `AdminRole` de `@veo/shared-types`.
 */
import { AdminRole } from '@veo/shared-types';

/** Permiso fino del dominio admin (id `recurso:acción`). Unión canónica — id de columna de la matriz RBAC. */
export type Permission =
  | 'ops:view'
  | 'trips:view'
  | 'drivers:view'
  | 'drivers:approve'
  | 'drivers:suspend'
  | 'drivers:delete'
  | 'operators:view'
  | 'operators:create'
  | 'panics:view'
  | 'panics:ack'
  | 'panics:resolve'
  | 'fleet:view'
  | 'fleet:review'
  | 'fleet:manage'
  | 'finance:view'
  | 'finance:payout'
  | 'finance:refund'
  | 'finance:manage'
  | 'media:view'
  | 'media:request'
  | 'media:approve'
  | 'live:view'
  | 'pricing:view'
  | 'pricing:manage'
  | 'catalog:view'
  | 'catalog:manage'
  | 'dispatch:view'
  | 'dispatch:manage'
  | 'audit:view'
  | 'audit:verify'
  | 'gobierno:manage';

const { SUPPORT_L1, SUPPORT_L2, COMPLIANCE_SUPERVISOR, DISPATCHER, FINANCE, ADMIN, SUPERADMIN } =
  AdminRole;

/**
 * Permiso → roles permitidos por el servidor (la BASE). Cada entrada espeja el controller/@Roles del admin-bff
 * que refleja. Cuando un método no declara @Roles propio, hereda los @Roles de su controller (clase).
 */
export const PERMISSION_ROLES: Record<Permission, readonly AdminRole[]> = {
  // analytics.controller (clase): overview que alimenta el dashboard "En vivo".
  'ops:view': [SUPPORT_L2, DISPATCHER, COMPLIANCE_SUPERVISOR, FINANCE, ADMIN, SUPERADMIN],
  // ops.controller (clase): listados de viajes/conductores.
  'trips:view': [SUPPORT_L1, SUPPORT_L2, DISPATCHER, COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  'drivers:view': [SUPPORT_L1, SUPPORT_L2, DISPATCHER, COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  // ops.controller drivers/:id/approve|reject.
  'drivers:approve': [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  // ops.controller drivers/:id/suspend: suspensión manual (SAFETY). Mismos roles que approve/reject.
  'drivers:suspend': [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  // ops.controller DELETE drivers/:id: borrado en cascada del conductor (irreversible). SOLO SUPERADMIN +
  // step-up MFA fresca (el bff revalida @Roles(SUPERADMIN) + @RequireStepUpMfa; la UI solo refleja).
  'drivers:delete': [SUPERADMIN],
  // ops.controller GET operators + operators/:id/reinvite|reject: SOLO ADMIN/SUPERADMIN (gestión de staff).
  'operators:view': [ADMIN, SUPERADMIN],
  // ops.controller POST operators (crear operador con roles → INVITED + link de invitación; step-up MFA).
  'operators:create': [ADMIN, SUPERADMIN],
  // security.controller (clase): listar/ver/acusar pánicos (ack hereda los roles de la clase).
  'panics:view': [SUPPORT_L2, DISPATCHER, COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  'panics:ack': [SUPPORT_L2, DISPATCHER, COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  // security.controller panics/:id/resolve.
  'panics:resolve': [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  // fleet.controller (clase): vehículos/documentos/inspecciones/vencimientos (review hereda la clase).
  'fleet:view': [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  'fleet:review': [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  // fleet.controller (clase) POST vehicles/documents/inspections: alta de flota. Mismos roles que review.
  'fleet:manage': [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  // finance.controller (clase): listado de payouts y reembolsos (refund hereda la clase).
  'finance:view': [FINANCE, ADMIN, SUPERADMIN],
  'finance:refund': [FINANCE, ADMIN, SUPERADMIN],
  // finance.controller payouts/run: SOLO FINANCE (ni ADMIN ni SUPERADMIN; el servidor los negaría).
  'finance:payout': [FINANCE],
  // finance.controller PUT commission (F2.7): cambiar la tasa de comisión ON-DEMAND. Decisión financiera +
  // step-up MFA. Mismos roles que el resto de config financiera (espejo de pricing:manage).
  'finance:manage': [FINANCE, ADMIN, SUPERADMIN],
  // media.controller (clase): solicitar/ver acceso a video. ADMIN puede SOLICITAR y VER, pero NO APROBAR.
  'media:view': [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  'media:request': [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  // media.controller access-requests/:id/approve (@Roles a nivel MÉTODO): AUTORIZAR el acceso a dato
  // sensible (video Ley 29733) es función de CUMPLIMIENTO. Separación de funciones (decisión del dueño):
  // COMPLIANCE_SUPERVISOR + SUPERADMIN, NO ADMIN. Complementa el four-eyes por IDENTIDAD (approverId ≠
  // requestedBy) del media-service. approve además exige step-up MFA fresca.
  'media:approve': [COMPLIANCE_SUPERVISOR, SUPERADMIN],
  // media.controller POST live/token: muro de cámaras EN VIVO. Doble-auth (rol + step-up MFA fresca).
  // Mismos roles que el acceso a grabaciones; la MFA fresca la exige el StepUpDialog + el guard del bff.
  'live:view': [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  // pricing.controller (clase): ver el schedule de modo PUJA↔FIJO. Decisión comercial/financiera.
  'pricing:view': [FINANCE, ADMIN, SUPERADMIN],
  // pricing.controller PUT mode-schedule: reemplazar el schedule (mutación global). Mismos roles.
  'pricing:manage': [FINANCE, ADMIN, SUPERADMIN],
  // catalog.controller (clase): ver el catálogo de ofertas (enabled por oferta). Decisión comercial/operativa.
  'catalog:view': [FINANCE, ADMIN, SUPERADMIN],
  // catalog.controller PUT /catalog: reemplazar el overlay (prender/apagar ofertas). Mismos roles.
  'catalog:manage': [FINANCE, ADMIN, SUPERADMIN],
  // dispatch-config.controller (clase): ver la config de RADIOS (k-rings) de dispatch. DISPATCHER es el
  // rol operativo natural del despacho; ADMIN/SUPERADMIN mantienen control.
  'dispatch:view': [DISPATCHER, ADMIN, SUPERADMIN],
  // dispatch-config.controller PUT radius-config: reemplazar los k-rings (mutación global). Mismos roles.
  'dispatch:manage': [DISPATCHER, ADMIN, SUPERADMIN],
  // audit.controller (clase): listado y verificación de la hash-chain.
  // Separación de funciones (decisión del dueño): COMPLIANCE_SUPERVISOR + SUPERADMIN, NO ADMIN.
  'audit:view': [COMPLIANCE_SUPERVISOR, SUPERADMIN],
  'audit:verify': [COMPLIANCE_SUPERVISOR, SUPERADMIN],
  // gobierno.controller (clase, admin-bff): TODO Gobierno → Políticas/Permisos es EXCLUSIVO de SUPERADMIN
  // (@Roles(SUPERADMIN) a nivel de clase; el PUT suma @RequireStepUpMfa). Espejo del borde de autoridad
  // del registro PBAC (ADR-024 §6). Gatea el grupo GOBIERNO del nav + las páginas /gobierno/*.
  'gobierno:manage': [SUPERADMIN],
};

/** Lista canónica de permisos (orden estable de la matriz). Fuente única de "¿es un permiso válido?". */
export const PERMISSION_LIST = Object.keys(PERMISSION_ROLES) as readonly Permission[];

/** Narrowing: ¿`value` es un `Permission` del catálogo? (valida el eje columna del overlay). */
export function isPermission(value: string): value is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSION_ROLES, value);
}

/** Narrowing: ¿`value` es un `AdminRole` canónico? (valida el eje fila del overlay). */
export function isAdminRole(value: string): value is AdminRole {
  return (Object.values(AdminRole) as readonly string[]).includes(value);
}

/**
 * ¿La BASE concede `permission` al `role`? El corazón del invariante subtract-only del Overlay (ADR-025 §3):
 * un override solo puede RESTAR sobre un par que la base YA concede. Si la base no lo concede, "restarlo" sería
 * un intento encubierto de CONCEDER (el overlay solo agrega negaciones) → el server lo rechaza.
 */
export function baseGrants(role: string, permission: string): boolean {
  if (!isPermission(permission)) return false;
  return (PERMISSION_ROLES[permission] as readonly string[]).includes(role);
}

/**
 * Permisos LEGAL-MANDATORY (ADR-025 §3 · separación de funciones · Ley 29733): NO son restables por el Overlay,
 * en NINGÚN rol. Un candado análogo al `mandatory` de una Política. Si el superadmin intentara "ocultar" uno de
 * estos, quebraría la segregación de funciones exigida por la ley (el auditor dejaría de poder auditar; nadie
 * podría desembolsar). El registro rechaza la RESTA (hidden=true) sobre ellos.
 *
 * El set (ref. audit de segregación · memoria `admin/audit-seams-rbac-2026-07`):
 *  - `audit:view` / `audit:verify`: la CAPACIDAD de auditar la hash-chain es la garantía de control interno
 *    (Ley 29733). Restársela a COMPLIANCE/SUPERADMIN cegaría la fiscalización → prohibido.
 *  - `finance:payout`: EJECUTAR desembolsos es función exclusiva de FINANCE (ni ADMIN ni SUPERADMIN lo tienen);
 *    restárselo dejaría a la plataforma SIN ejecutor de pagos → prohibido (segregación de funciones financieras).
 */
export const LEGAL_MANDATORY_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'audit:view',
  'audit:verify',
  'finance:payout',
]);

/** ¿`permission` es un candado legal no-restable por el Overlay? */
export function isLegalMandatoryPermission(permission: string): boolean {
  return isPermission(permission) && LEGAL_MANDATORY_PERMISSIONS.has(permission);
}

/**
 * Predicado del overlay: dado un par `(role, permission)`, ¿está RESTADO (hidden)? Inyecta la mitad editable
 * del overlay (el `PolicyReader`/`PolicyReaderPort` del runtime, o un stub en tests). DEFAULT semántico `false`
 * = no restado = rige la base (el caller endurece: ausencia de reader → siempre `false`).
 */
export type IsPermissionHidden = (role: string, permission: string) => boolean;

/**
 * NÚCLEO COMPARTIDO del overlay (ADR-025 §3) — la MISMA fórmula del efectivo que enforcea el server y que
 * proyecta la sesión al front, en UN solo lugar para no divergir:
 *
 *   efectivo(user, P) = OR sobre los roles del user de ( baseGrants(role, P) AND NOT isHidden(role, P) )
 *
 * Un user multi-rol conserva P si AL MENOS UNO de sus roles lo tiene en base y NO restado (el más permisivo:
 * el overlay solo RESTA por-rol, nunca por-user). Lo usan el `PermissionOverlayGuard` (con el puerto síncrono)
 * y el cómputo de `hiddenPermissions` de la sesión (`computeHiddenPermissions`).
 */
export function isPermissionEffective(
  roles: readonly string[],
  permission: string,
  isHidden: IsPermissionHidden,
): boolean {
  return roles.some((role) => baseGrants(role, permission) && !isHidden(role, permission));
}

/**
 * Los permisos que el OVERLAY le RESTA a un actor con estos `roles`: cada `P` del catálogo que la BASE concede
 * a ALGÚN rol del actor pero cuyo efectivo es `false` (todos los roles que lo concedían lo tienen restado).
 *
 * Es EXACTAMENTE el complemento de lo que bloquearía el guard, y lo que el front usa para OCULTAR nav/botones/
 * páginas (compone `base ∧ ¬oculto` en `can()`). Solo se listan permisos base-concedidos: un `P` que el actor
 * nunca tuvo (base no lo concede a ninguno de sus roles) NO es "oculto por el overlay", simplemente no lo tiene.
 */
export function computeHiddenPermissions(
  roles: readonly string[],
  isHidden: IsPermissionHidden,
): Permission[] {
  return PERMISSION_LIST.filter(
    (permission) =>
      roles.some((role) => baseGrants(role, permission)) &&
      !isPermissionEffective(roles, permission, isHidden),
  );
}
