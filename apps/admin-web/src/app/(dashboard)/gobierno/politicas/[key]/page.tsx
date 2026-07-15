'use client';

import { use } from 'react';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { PermissionState } from '@/components/ui/states';
import { PolicyDetailView } from '@/components/gobierno/policy-detail-view';

/**
 * Gobierno → Políticas → Detalle (drill-in · PBAC · ADR-024). Ruta `/gobierno/politicas/[key]` (la key lleva
 * puntos, ej. `media.dual-auth`). Gate de presentación con `gobierno:manage` (→ SUPERADMIN); el admin-bff
 * (@Roles(SUPERADMIN)) re-autoriza server-side. El componente resuelve los 4 estados (loading/error/404/data).
 */
export default function PolicyDetailPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params);
  const user = useSession();
  const canManage = can(user, 'gobierno:manage');

  if (!canManage) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Política"
          breadcrumbs={[{ label: 'Gobierno' }, { label: 'Políticas' }, { label: 'Detalle' }]}
        />
        <PermissionState
          className="flex-1"
          section="Políticas de gobierno"
          permission="gobierno:manage"
        />
      </div>
    );
  }

  return <PolicyDetailView policyKey={decodeURIComponent(key)} canManage={canManage} />;
}
