'use client';

import { Fragment } from 'react';
import { Check, Lock, Minus } from 'lucide-react';
import { AdminRole } from '@veo/shared-types';
import { PERMISSION_ROLES, can, type Permission } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/states';

/**
 * Gobierno → Permisos y visibilidad. Visualización READ-ONLY de la matriz RBAC REAL de la app (`PERMISSION_ROLES`
 * de rbac.ts, espejo exacto de los `@Roles` de cada controller del admin-bff): qué rol tiene qué permiso. Es dato
 * real del front, no necesita backend. El overlay EDITABLE de permisos es NO-GOAL del ADR-024 §9 — acá solo se
 * muestra la matriz vigente para que el link del nav no quede muerto.
 */

/** Columnas = roles, en orden de jerarquía ascendente (mismo criterio que el rank de AdminRole). */
const ROLE_COLS: { role: AdminRole; short: string; label: string }[] = [
  { role: AdminRole.SUPPORT_L1, short: 'N1', label: 'Soporte N1' },
  { role: AdminRole.SUPPORT_L2, short: 'N2', label: 'Soporte N2' },
  { role: AdminRole.DISPATCHER, short: 'DSP', label: 'Despacho' },
  { role: AdminRole.COMPLIANCE_SUPERVISOR, short: 'CMP', label: 'Cumplimiento' },
  { role: AdminRole.FINANCE, short: 'FIN', label: 'Finanzas' },
  { role: AdminRole.ADMIN, short: 'ADM', label: 'Administrador' },
  { role: AdminRole.SUPERADMIN, short: 'SUP', label: 'Superadmin' },
];

const RESOURCE_LABELS: Record<string, string> = {
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

const ACTION_LABELS: Record<string, string> = {
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

function actionOf(permission: Permission): string {
  const action = permission.split(':')[1] ?? permission;
  return ACTION_LABELS[action] ?? action;
}

/** Agrupa los permisos por recurso (prefijo antes de ':') preservando el orden de declaración de rbac.ts. */
function groupByResource(): { resource: string; label: string; permissions: Permission[] }[] {
  const order: string[] = [];
  const groups = new Map<string, Permission[]>();
  for (const permission of Object.keys(PERMISSION_ROLES) as Permission[]) {
    const resource = permission.split(':')[0] ?? permission;
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

export default function PermissionsPage() {
  const user = useSession();
  const canView = can(user, 'gobierno:manage');
  const groups = groupByResource();

  if (!canView) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Permisos y visibilidad"
          breadcrumbs={[{ label: 'Gobierno' }, { label: 'Permisos y visibilidad' }]}
        />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="La matriz de permisos es exclusiva del rol SUPERADMIN."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Permisos y visibilidad"
        description="Qué puede ver y hacer cada rol del panel. Es la matriz RBAC vigente (espejo exacto de los @Roles del admin-bff). Vista de solo lectura: los roles se asignan al crear cada operador."
        breadcrumbs={[{ label: 'Gobierno' }, { label: 'Permisos y visibilidad' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        <div className="mt-4 overflow-x-auto rounded-xl border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2/50">
                <th className="sticky left-0 z-10 bg-surface px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                  Permiso
                </th>
                {ROLE_COLS.map((c) => (
                  <th
                    key={c.role}
                    className="px-3 py-3 text-center text-xs font-semibold text-ink-muted"
                    title={c.label}
                  >
                    {c.short}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <Fragment key={group.resource}>
                  <tr className="bg-surface-2/30">
                    <td
                      colSpan={ROLE_COLS.length + 1}
                      className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle"
                    >
                      {group.label}
                    </td>
                  </tr>
                  {group.permissions.map((permission) => {
                    const allowed = PERMISSION_ROLES[permission] as readonly string[];
                    return (
                      <tr
                        key={permission}
                        className="border-b border-border last:border-b-0 hover:bg-surface-2/30"
                      >
                        <td className="sticky left-0 z-10 bg-surface px-4 py-2.5">
                          <span className="text-ink">{actionOf(permission)}</span>
                          <span className="ml-2 font-mono text-xs text-ink-subtle">
                            {permission}
                          </span>
                        </td>
                        {ROLE_COLS.map((c) => {
                          const has = allowed.includes(c.role);
                          return (
                            <td key={c.role} className="px-3 py-2.5 text-center">
                              {has ? (
                                <Check
                                  className="mx-auto size-4 text-success"
                                  aria-label={`${c.label}: permitido`}
                                />
                              ) : (
                                <Minus
                                  className={cn('mx-auto size-4 text-ink-subtle/40')}
                                  aria-label={`${c.label}: no permitido`}
                                />
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-xs text-ink-subtle">
          La edición de esta matriz (overlay de permisos por rol) está fuera de alcance por diseño
          (ADR-024 §9): los permisos son el espejo del código del admin-bff. Los roles de cada
          operador se asignan en Operación › Operadores.
        </p>
      </div>
    </div>
  );
}
