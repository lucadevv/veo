import type { SessionUser } from '@veo/api-client';
import { AdminRole } from '@veo/shared-types';

/**
 * RBAC de presentación. Oculta/deshabilita acciones sensibles en la UI según los roles del
 * sessionUser. La AUTORIDAD real es el admin-bff (que vuelve a verificar permisos con sus guards);
 * esto es defensa en profundidad para la experiencia, no el control de seguridad final.
 *
 * El mapa `PERMISSION_ROLES` es un ESPEJO EXACTO de los `@Roles` declarados en cada controller del
 * admin-bff. Roles canónicos = `AdminRole` de @veo/shared-types (SUPPORT_L1, SUPPORT_L2,
 * COMPLIANCE_SUPERVISOR, DISPATCHER, FINANCE, ADMIN, SUPERADMIN). Si el servidor lo negaría, la UI lo oculta.
 */
export type Permission =
  | 'ops:view'
  | 'trips:view'
  | 'drivers:view'
  | 'drivers:approve'
  | 'panics:view'
  | 'panics:ack'
  | 'panics:resolve'
  | 'fleet:view'
  | 'fleet:review'
  | 'finance:view'
  | 'finance:payout'
  | 'finance:refund'
  | 'media:view'
  | 'media:request'
  | 'media:approve'
  | 'audit:view'
  | 'audit:verify';

const {
  SUPPORT_L1,
  SUPPORT_L2,
  COMPLIANCE_SUPERVISOR,
  DISPATCHER,
  FINANCE,
  ADMIN,
  SUPERADMIN,
} = AdminRole;

/**
 * Permiso → roles permitidos por el servidor. Cada entrada cita el controller/@Roles de admin-bff
 * que refleja. Cuando un método no declara @Roles propio, hereda los @Roles de su controller (clase).
 */
const PERMISSION_ROLES: Record<Permission, readonly AdminRole[]> = {
  // analytics.controller (clase): overview que alimenta el dashboard "En vivo".
  'ops:view': [SUPPORT_L2, DISPATCHER, COMPLIANCE_SUPERVISOR, FINANCE, ADMIN, SUPERADMIN],
  // ops.controller (clase): listados de viajes/conductores.
  'trips:view': [SUPPORT_L1, SUPPORT_L2, DISPATCHER, COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  'drivers:view': [SUPPORT_L1, SUPPORT_L2, DISPATCHER, COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  // ops.controller drivers/:id/approve|reject.
  'drivers:approve': [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  // security.controller (clase): listar/ver/acusar pánicos (ack hereda los roles de la clase).
  'panics:view': [SUPPORT_L2, DISPATCHER, COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  'panics:ack': [SUPPORT_L2, DISPATCHER, COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  // security.controller panics/:id/resolve.
  'panics:resolve': [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  // fleet.controller (clase): vehículos/documentos/inspecciones/vencimientos (review hereda la clase).
  'fleet:view': [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  'fleet:review': [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  // finance.controller (clase): listado de payouts y reembolsos (refund hereda la clase).
  'finance:view': [FINANCE, ADMIN, SUPERADMIN],
  'finance:refund': [FINANCE, ADMIN, SUPERADMIN],
  // finance.controller payouts/run: SOLO FINANCE (ni ADMIN ni SUPERADMIN; el servidor los negaría).
  'finance:payout': [FINANCE],
  // media.controller (clase): solicitar/ver/aprobar acceso a video (approve además exige step-up MFA).
  'media:view': [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  'media:request': [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  'media:approve': [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  // audit.controller (clase): listado y verificación de la hash-chain.
  'audit:view': [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
  'audit:verify': [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN],
};

export function can(user: SessionUser | null | undefined, permission: Permission): boolean {
  if (!user) return false;
  const allowed = PERMISSION_ROLES[permission] as readonly string[];
  return user.roles.some((role) => allowed.includes(role));
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
