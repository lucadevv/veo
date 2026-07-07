'use client';

import { Lock, Scale } from 'lucide-react';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/states';

/**
 * Reconciliación — historial de las corridas de conciliación diaria (BR-P07): lo capturado en DB (Yape/Plin)
 * contra el extracto del gateway, con la discrepancia y las que alertaron. El backend YA expone
 * GET /finance/reconciliation (el ReconciliationRun del cron, paginado). La UI se migra desde el diseño
 * (veo.pen). Gate de presentación con `finance:view`; el admin-bff (RolesGuard) re-autoriza server-side.
 */
export default function ReconciliationPage() {
  const user = useSession();

  if (!can(user, 'finance:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Reconciliación"
          breadcrumbs={[{ label: 'Finanzas' }, { label: 'Reconciliación' }]}
        />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol FINANCE o ADMIN para ver la reconciliación."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Reconciliación"
        description="Historial de las corridas de conciliación diaria: lo capturado en DB (Yape/Plin) contra el extracto del gateway, la discrepancia por corrida y las que superaron el umbral de alerta."
        breadcrumbs={[{ label: 'Finanzas' }, { label: 'Reconciliación' }]}
      />
      <EmptyState
        className="flex-1"
        icon={<Scale className="size-6" aria-hidden />}
        title="Pantalla en migración desde el diseño"
        description="El backend ya está listo (GET /finance/reconciliation, el historial del cron paginado). La UI se está migrando desde veo.pen."
      />
    </div>
  );
}
