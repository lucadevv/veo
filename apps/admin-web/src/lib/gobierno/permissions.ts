import { AdminRole } from '@veo/shared-types';
import {
  PERMISSION_LIST,
  baseGrants,
  isLegalMandatoryPermission,
  type Permission,
} from '@veo/policy';
import type { PermissionOverrideView } from '@/lib/api/schemas';

/**
 * Núcleo COMPARTIDO de presentación del gobierno unificado (ADR-025 §3) para admin-web. Centraliza el
 * etiquetado (roles/recursos/acciones), el agrupamiento por módulo y la composición del efectivo
 * `base ∧ ¬overlay` en UN solo lugar, para que la MATRIZ (rol×permiso) y el DETALLE por rol no dupliquen
 * la lógica. La matriz BASE la aporta `@veo/policy` (`PERMISSION_ROLES`); el overlay subtract-only llega por
 * `GET /gobierno/permission-overrides`. El servidor RE-autoriza; esto es solo la proyección de UI.
 */

/** Columnas/roles en orden de jerarquía ascendente (mismo criterio que el rank de AdminRole). */
export const ROLE_COLS: { role: AdminRole; short: string; label: string }[] = [
  { role: AdminRole.SUPPORT_L1, short: 'L1', label: 'Soporte L1' },
  { role: AdminRole.SUPPORT_L2, short: 'L2', label: 'Soporte L2' },
  { role: AdminRole.DISPATCHER, short: 'DSP', label: 'Despacho' },
  { role: AdminRole.COMPLIANCE_SUPERVISOR, short: 'CMP', label: 'Cumplimiento' },
  { role: AdminRole.FINANCE, short: 'FIN', label: 'Finanzas' },
  { role: AdminRole.ADMIN, short: 'ADM', label: 'Administrador' },
  { role: AdminRole.SUPERADMIN, short: 'SUP', label: 'Superadmin' },
];

const ROLE_META = new Map(ROLE_COLS.map((c) => [c.role, c]));

/** Metadatos (short/label) de un rol, o `null` si el string no es un `AdminRole` conocido. */
export function roleMeta(role: string): { role: AdminRole; short: string; label: string } | null {
  return ROLE_META.get(role as AdminRole) ?? null;
}

/** Narrowing del param de ruta `[role]` → `AdminRole` canónico (o `null` si es desconocido). */
export function parseRoleParam(param: string): AdminRole | null {
  return ROLE_META.has(param as AdminRole) ? (param as AdminRole) : null;
}

export const RESOURCE_LABELS: Record<string, string> = {
  ops: 'Operación en vivo',
  trips: 'Viajes',
  drivers: 'Conductores',
  operators: 'Operadores',
  panics: 'Pánicos',
  fleet: 'Flota',
  finance: 'Finanzas',
  media: 'Video',
  live: 'Cámaras en vivo',
  pricing: 'Precios',
  catalog: 'Catálogo',
  dispatch: 'Dispatch',
  audit: 'Auditoría',
  gobierno: 'Gobierno',
};

export const ACTION_LABELS: Record<string, string> = {
  view: 'Ver',
  create: 'Crear',
  approve: 'Aprobar',
  suspend: 'Suspender',
  delete: 'Eliminar',
  ack: 'Reconocer',
  resolve: 'Resolver',
  review: 'Revisar',
  manage: 'Gestionar',
  payout: 'Liquidar',
  refund: 'Reembolsar',
  request: 'Solicitar',
  verify: 'Verificar',
};

/** Etiqueta humana de la acción de un permiso (`drivers:approve` → "Aprobar"). */
export function actionOf(permission: Permission): string {
  const action = permission.split(':')[1] ?? permission;
  return ACTION_LABELS[action] ?? action;
}

/** Recurso (prefijo antes de ':') de un permiso. */
export function resourceOf(permission: Permission): string {
  return permission.split(':')[0] ?? permission;
}

/** Agrupa los permisos por recurso preservando el orden canónico de `PERMISSION_LIST`. */
export function groupByResource(): { resource: string; label: string; permissions: Permission[] }[] {
  const order: string[] = [];
  const groups = new Map<string, Permission[]>();
  for (const permission of PERMISSION_LIST) {
    const resource = resourceOf(permission);
    const existing = groups.get(resource);
    if (existing) {
      existing.push(permission);
    } else {
      groups.set(resource, [permission]);
      order.push(resource);
    }
  }
  return order.map((resource) => ({
    resource,
    label: RESOURCE_LABELS[resource] ?? resource,
    permissions: groups.get(resource) ?? [],
  }));
}

/** Clave estable de un par (rol, permiso) para sets/maps del overlay. */
export const keyOf = (role: string, permission: string) => `${role}|${permission}`;

/**
 * Estado EFECTIVO de un permiso para un rol (proyección `base ∧ ¬overlay`):
 *  - `na`      → la base no concede el permiso a ese rol (no aplica).
 *  - `legal`   → candado Ley 29733: concedido y NO restable por el overlay.
 *  - `hidden`  → la base lo concede pero el overlay lo RESTÓ (oculto en la UI del rol).
 *  - `visible` → concedido por la base, no restado.
 */
export type PermissionStatus = 'na' | 'legal' | 'hidden' | 'visible';

export interface RolePermissionRow {
  permission: Permission;
  action: string;
  base: boolean;
  legal: boolean;
  hidden: boolean;
  status: PermissionStatus;
}

export interface RoleModuleGroup {
  resource: string;
  label: string;
  rows: RolePermissionRow[];
}

export interface RoleOverlayComposition {
  /** Solo los módulos donde el rol tiene AL MENOS un permiso base (los "no aplica" sueltos no aportan). */
  modules: RoleModuleGroup[];
  totals: { base: number; hidden: number; effective: number };
}

/**
 * Compone el overlay de UN rol client-side, con la MISMA fórmula que enforcea el server (identity) y que la
 * matriz usa por-celda. `overrides` = el estado del overlay (`GET /gobierno/permission-overrides`); solo cuentan
 * las filas `hidden:true` de ESTE rol. Los candados legales nunca se marcan ocultos (el registro los rechaza).
 */
export function composeRoleOverlay(
  role: AdminRole,
  overrides: PermissionOverrideView[],
): RoleOverlayComposition {
  const hiddenSet = new Set<string>();
  for (const o of overrides) if (o.hidden && o.role === role) hiddenSet.add(o.permission);

  let base = 0;
  let hidden = 0;
  const modules: RoleModuleGroup[] = [];

  for (const group of groupByResource()) {
    const rows: RolePermissionRow[] = group.permissions.map((permission) => {
      const isBase = baseGrants(role, permission);
      const legal = isLegalMandatoryPermission(permission);
      const isHidden = isBase && !legal && hiddenSet.has(permission);
      const status: PermissionStatus = !isBase ? 'na' : legal ? 'legal' : isHidden ? 'hidden' : 'visible';
      if (isBase) base += 1;
      if (isHidden) hidden += 1;
      return { permission, action: actionOf(permission), base: isBase, legal, hidden: isHidden, status };
    });
    if (rows.some((r) => r.base)) modules.push({ resource: group.resource, label: group.label, rows });
  }

  return { modules, totals: { base, hidden, effective: base - hidden } };
}
