'use client';

import { Check, X } from 'lucide-react';
import { useDriverDecision } from '@/lib/api/queries';
import type { DriverApproval } from '@/lib/api/schemas';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/** Acciones de aprobación/rechazo de conductor (gated por permiso drivers:approve). */
export function DriverActions({ driver }: { driver: DriverApproval }) {
  const user = useSession();
  const { toast } = useToast();
  const decision = useDriverDecision();

  if (!can(user, 'drivers:approve') || driver.status.toUpperCase() !== 'PENDING') {
    return <span className="text-xs text-ink-subtle">—</span>;
  }

  return (
    <div className="flex items-center gap-2">
      <ConfirmDialog
        trigger={
          <Button size="sm" variant="primary">
            <Check className="size-4" aria-hidden />
            Aprobar
          </Button>
        }
        title="Aprobar conductor"
        description={`Confirmas que ${driver.fullName ?? driver.id.slice(0, 8)} cumple los requisitos para operar.`}
        confirmLabel="Aprobar"
        onConfirm={async () => {
          await decision.mutateAsync({ id: driver.id, decision: 'approve' });
          toast({ tone: 'success', title: 'Conductor aprobado' });
        }}
      />
      <ConfirmDialog
        trigger={
          <Button size="sm" variant="secondary">
            <X className="size-4" aria-hidden />
            Rechazar
          </Button>
        }
        title="Rechazar conductor"
        description="Indica el motivo del rechazo. El conductor será notificado."
        confirmLabel="Rechazar"
        variant="danger"
        withReason
        reasonLabel="Motivo del rechazo"
        onConfirm={async (reason) => {
          await decision.mutateAsync({ id: driver.id, decision: 'reject', reason });
          toast({ tone: 'success', title: 'Conductor rechazado' });
        }}
      />
    </div>
  );
}
