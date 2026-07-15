'use client';

import { use } from 'react';
import { ShieldOff } from 'lucide-react';
import { usePermissionOverrides } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { parseRoleParam, roleMeta } from '@/lib/gobierno/permissions';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState, ErrorState, PermissionState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { RoleOverlayDetail } from '@/components/gobierno/role-overlay-detail';

/**
 * Gobierno → Permisos · DETALLE por rol (drill-in de la matriz · ADR-025 §3). Compone el efectivo `base ∧ ¬overlay`
 * de UN rol client-side (sin backend nuevo: overlay de `GET /gobierno/permission-overrides` + base de `@veo/policy`).
 * Gate de presentación con `gobierno:manage` (→ SUPERADMIN, como la matriz); el admin-bff re-autoriza server-side.
 * 4 estados: loading (skeleton) · error (retry) · 403 (PermissionState) · data. El param `[role]` desconocido → 404.
 */
export default function RolePermissionsDetailPage(props: { params: Promise<{ role: string }> }) {
  const { role: roleParam } = use(props.params);
  const user = useSession();
  const canManage = can(user, 'gobierno:manage');
  const role = parseRoleParam(roleParam);
  const query = usePermissionOverrides();

  const meta = role ? roleMeta(role) : null;
  const title = meta ? `${meta.label} · Overlay` : 'Rol desconocido';

  // "Personalizado" (fiel al frame): el rol tiene al menos un permiso RESTADO por el overlay (vs base pristina).
  const customized = !!(role && query.data?.some((o) => o.hidden && o.role === role));

  const header = (
    <PageHeader
      title={title}
      breadcrumbs={[
        { label: 'Gobierno' },
        { label: 'Permisos y visibilidad', href: '/gobierno/permisos' },
        { label: meta?.label ?? roleParam },
      ]}
      actions={
        role && query.data ? (
          <Badge tone={customized ? 'brand' : 'neutral'}>
            {customized ? 'Personalizado' : 'Sin cambios sobre la base'}
          </Badge>
        ) : null
      }
    />
  );

  // 403 — el gate de gobierno oculta la sección para este operador (no es un error del server).
  if (!canManage) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <PermissionState className="flex-1" section="Gobierno" permission="gobierno:manage" />
      </div>
    );
  }

  // Param inválido — el rol no existe en el catálogo de AdminRole.
  if (!role) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <EmptyState
          className="flex-1"
          icon={<ShieldOff className="size-6" aria-hidden />}
          title="Rol desconocido"
          description={`«${roleParam}» no es un rol del panel. Volvé a la matriz para elegir un rol válido.`}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : query.isLoading || !query.data ? (
          <div className="grid gap-5 pt-4 lg:grid-cols-[1fr_340px]">
            <div className="flex flex-col gap-5">
              <Skeleton className="h-28" />
              <Skeleton className="h-96" />
            </div>
            <div className="flex flex-col gap-5">
              <Skeleton className="h-40" />
              <Skeleton className="h-28" />
              <Skeleton className="h-44" />
            </div>
          </div>
        ) : (
          <RoleOverlayDetail role={role} overrides={query.data} />
        )}
      </div>
    </div>
  );
}
