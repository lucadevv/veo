'use client';

import { Ban } from 'lucide-react';
import { DriverStatus } from '@veo/shared-types';
import type { DriverApproval } from '@/lib/api/schemas';
import { useDriverSuspend } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/**
 * Suspender MANUALMENTE a un conductor de la flota (acción de SAFETY). Saca al conductor de circulación:
 * identity-service escribe `suspendedAt`, y el gate de turno (startShift) + el eligibility gate de dispatch
 * (ya existentes, fail-closed) impiden que inicie turno o acepte ofertas. La suspensión lleva MOTIVO
 * obligatorio que queda auditado. Gated por `drivers:suspend`; el admin-bff revalida
 * @Roles(COMPLIANCE_SUPERVISOR/ADMIN/SUPERADMIN) server-side (la UI no autoriza). Ya suspendido ⇒ no se ofrece.
 */
export function ActiveDriverActions({ driver }: { driver: DriverApproval }) {
  const user = useSession();
  const { toast } = useToast();
  const suspend = useDriverSuspend();

  if (!can(user, 'drivers:suspend')) {
    return <span className="text-xs text-ink-subtle">—</span>;
  }

  // Ya suspendido: no hay acción que ofrecer (la suspensión es idempotente, pero evitamos un botón inerte).
  if (driver.status === DriverStatus.SUSPENDED) {
    return <span className="text-xs text-ink-subtle">Suspendido</span>;
  }

  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="secondary">
          <Ban className="size-4" aria-hidden />
          Suspender
        </Button>
      }
      title="Suspender conductor"
      description={`Se suspenderá al conductor ${driver.id.slice(0, 8)}. No podrá iniciar turno ni aceptar viajes hasta reactivarlo. La acción queda auditada.`}
      confirmLabel="Suspender"
      variant="danger"
      withReason
      reasonLabel="Motivo de la suspensión (queda auditado)"
      onConfirm={async (reason) => {
        await suspend.mutateAsync({ id: driver.id, reason: reason ?? '' });
        toast({ tone: 'success', title: 'Conductor suspendido' });
      }}
    />
  );
}
