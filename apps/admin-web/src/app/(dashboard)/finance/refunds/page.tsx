'use client';

import { Lock, Undo2 } from 'lucide-react';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/states';

/**
 * Reembolsos — sección de finanzas para inspeccionar el cobro de un viaje y reembolsarlo (parcial/total). El
 * backend YA expone GET /finance/payments/by-trip/:tripId (inspección previa) + POST /finance/refunds/:tripId
 * (con step-up MFA + audit). La UI se migra desde el diseño (veo.pen). Gate de presentación con `finance:view`;
 * el admin-bff (RolesGuard) + payment-service re-autorizan server-side. Nada se decide en la UI.
 */
export default function RefundsPage() {
  const user = useSession();

  if (!can(user, 'finance:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Reembolsos"
          breadcrumbs={[{ label: 'Finanzas' }, { label: 'Reembolsos' }]}
        />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol FINANCE o ADMIN para ver los reembolsos."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Reembolsos"
        description="Buscá el viaje, revisá el cobro reembolsable (monto, método, saldo) y reembolsá parcial o total. Cada reembolso pide confirmación con step-up MFA y queda auditado."
        breadcrumbs={[{ label: 'Finanzas' }, { label: 'Reembolsos' }]}
      />
      <EmptyState
        className="flex-1"
        icon={<Undo2 className="size-6" aria-hidden />}
        title="Pantalla en migración desde el diseño"
        description="El backend ya está listo (GET payment-by-trip para inspeccionar + POST refunds con MFA). La UI se está migrando desde veo.pen."
      />
    </div>
  );
}
