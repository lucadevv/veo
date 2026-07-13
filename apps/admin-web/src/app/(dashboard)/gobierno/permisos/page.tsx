'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Lock } from 'lucide-react';
import { usePermissionOverrides } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { PermissionsMatrix } from '@/components/gobierno/permissions-matrix';

/**
 * Gobierno → Permisos y visibilidad (OVERLAY subtract-only · ADR-025 §3, Ola 4 · F0). Matriz INTERACTIVA
 * rol×permiso: edita el overlay que RESTA (oculta) permisos que la matriz BASE (`PERMISSION_ROLES` de
 * @veo/policy) concede. El efectivo se compone `base ∧ ¬override`; el overlay JAMÁS concede de más y los candados
 * de la Ley 29733 no se pueden restar. Gate de presentación con `gobierno:manage` (→ SUPERADMIN); el admin-bff
 * (@Roles(SUPERADMIN)) y el PUT (@RequireStepUpMfa) re-autorizan server-side.
 *
 * F0 = registro + edición del overlay. HOY el overlay OCULTA/RESTA en la UI de cada rol; el enforcement duro
 * server-side (guard base ∧ ¬override) llega en la fase siguiente (F1) — no se afirma que ya bloquee en el server.
 */
export default function PermissionsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-ink-muted">Cargando…</div>}>
      <PermissionsPageInner />
    </Suspense>
  );
}

function PermissionsPageInner() {
  const user = useSession();
  const canManage = can(user, 'gobierno:manage');
  const query = usePermissionOverrides();
  // Deep-link "Editar overlay en la matriz" (role-overlay-detail): `?role=X` enfoca la COLUMNA de ese rol.
  const focusRole = useSearchParams().get('role');

  if (!canManage) {
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
        description="Qué ve y hace cada rol del panel. La matriz BASE es código (cambia por PR); acá aplicás un overlay que solo RESTA: ocultás en la UI de un rol permisos que la base le concede. Hoy el overlay OCULTA/RESTA en la interfaz; el bloqueo duro server-side (guard base ∧ ¬override) llega en la fase siguiente (F1). Los candados de la Ley 29733 no se pueden restar."
        breadcrumbs={[{ label: 'Gobierno' }, { label: 'Permisos y visibilidad' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : query.isLoading || !query.data ? (
          <div className="flex flex-col gap-4 pt-4">
            <Skeleton className="h-8 w-full max-w-xl" />
            <Skeleton className="h-96" />
          </div>
        ) : (
          <PermissionsMatrix overrides={query.data} focusRole={focusRole} />
        )}
      </div>
    </div>
  );
}
