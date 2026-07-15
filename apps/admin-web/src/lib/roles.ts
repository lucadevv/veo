import { AdminRole, ADMIN_ROLE_RANK, maxRoleRank } from '@veo/shared-types';
import type { AdminRoleValue } from '@/lib/api/schemas';

/** Etiqueta humana por rol RBAC (chips + selectores). */
export const ROLE_LABELS: Record<string, string> = {
  SUPPORT_L1: 'Soporte N1',
  SUPPORT_L2: 'Soporte N2',
  DISPATCHER: 'Despachador',
  COMPLIANCE_SUPERVISOR: 'Cumplimiento',
  FINANCE: 'Finanzas',
  ADMIN: 'Administrador',
  SUPERADMIN: 'Superadmin',
};

/** Tono del chip por rol (color semántico, fiel al board). */
export type RoleTone = 'brand' | 'purple' | 'success' | 'warn' | 'info' | 'neutral';

export const ROLE_TONE: Record<string, RoleTone> = {
  SUPERADMIN: 'brand',
  ADMIN: 'info',
  COMPLIANCE_SUPERVISOR: 'purple',
  FINANCE: 'success',
  DISPATCHER: 'warn',
  SUPPORT_L1: 'neutral',
  SUPPORT_L2: 'neutral',
};

/**
 * Clases del chip por tono — FUENTE ÚNICA (antes copiada en operators/page y operators/[id]).
 * `info` usa su token (--info); `purple` es el ÚNICO hex sancionado por el board (rol Cumplimiento,
 * sin token global a propósito: no es parte de la paleta semántica, es el distintivo de ese rol).
 */
export const ROLE_PILL_CLS: Record<RoleTone, string> = {
  brand: 'bg-accent/10 text-accent',
  purple: 'bg-[#7C3AED]/10 text-[#7C3AED]',
  success: 'bg-success/10 text-success',
  warn: 'bg-warn/10 text-warn',
  info: 'bg-info/10 text-info',
  neutral: 'bg-bg text-ink-muted',
};

/** Descripción humana por permiso (columna derecha de "Permisos efectivos"). Slug desconocido → sin desc. */
export const PERMISSION_LABELS: Record<string, string> = {
  'ops:view': 'Ve la operación en vivo',
  'trips:view': 'Ve los viajes',
  'drivers:view': 'Ve conductores',
  'drivers:approve': 'Aprueba KYC de conductores',
  'drivers:suspend': 'Suspende conductores',
  'drivers:delete': 'Elimina conductores',
  'operators:view': 'Ve operadores del panel',
  'operators:create': 'Da de alta operadores',
  'panics:view': 'Ve incidentes de pánico',
  'panics:ack': 'Reconoce pánicos',
  'panics:resolve': 'Resuelve pánicos',
  'fleet:view': 'Ve la flota',
  'fleet:review': 'Revisa documentos de flota',
  'fleet:manage': 'Gestiona la flota',
  'finance:view': 'Ve finanzas',
  'finance:payout': 'Libera liquidaciones',
  'finance:refund': 'Emite reembolsos',
  'finance:manage': 'Gestiona finanzas',
  'media:view': 'Ve solicitudes de video',
  'media:request': 'Solicita acceso a video',
  'media:approve': 'Autoriza acceso a video',
  'live:view': 'Ve cámara en vivo',
  'pricing:view': 'Ve precios',
  'pricing:manage': 'Gestiona precios',
  'catalog:view': 'Ve el catálogo',
  'catalog:manage': 'Gestiona el catálogo',
  'dispatch:view': 'Ve radios de dispatch',
  'dispatch:manage': 'Gestiona radios de dispatch',
  'audit:view': 'Lee auditoría',
  'audit:verify': 'Verifica la cadena de auditoría',
  'gobierno:manage': 'Gestiona permisos y políticas',
};

/**
 * Roles que el actor PUEDE otorgar según su rango (anti-escalada `canGrantRoles`): rango estrictamente
 * menor al suyo, salvo SUPERADMIN que sí otorga SUPERADMIN. Solo los ofrecemos para no inducir un 403;
 * el servidor revalida igual. Orden ascendente por rango para una lista estable.
 */
export function grantableRoles(roles: readonly string[]): AdminRoleValue[] {
  const actorRank = maxRoleRank(roles as AdminRole[]);
  const isSuperadmin = actorRank >= ADMIN_ROLE_RANK[AdminRole.SUPERADMIN];
  return (Object.keys(ROLE_LABELS) as AdminRoleValue[])
    .filter((r) => ADMIN_ROLE_RANK[r] < actorRank || (isSuperadmin && r === AdminRole.SUPERADMIN))
    .sort((a, b) => ADMIN_ROLE_RANK[a] - ADMIN_ROLE_RANK[b]);
}
