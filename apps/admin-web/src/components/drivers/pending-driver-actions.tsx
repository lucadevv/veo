'use client';

import { Check, X } from 'lucide-react';
import { useDriverDecision } from '@/lib/api/queries';
import type { PendingDriver } from '@/lib/api/schemas';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/**
 * Aprobar/rechazar un conductor de la COLA REAL de pendientes (identity pending-approval). El conductor ya
 * ES pendiente (viene de esa cola), por eso las acciones se muestran sin chequear estado — gated por
 * `drivers:approve`. El admin-bff revalida @Roles(COMPLIANCE_SUPERVISOR/ADMIN/SUPERADMIN): la UI no autoriza.
 */
export function PendingDriverActions({ driver }: { driver: PendingDriver }) {
  const user = useSession();
  const { toast } = useToast();
  const decision = useDriverDecision();

  if (!can(user, 'drivers:approve')) {
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
        description={`Confirmas que el conductor ${driver.id.slice(0, 8)} cumple los requisitos (antecedentes) para operar.`}
        confirmLabel="Aprobar"
        onConfirm={async () => {
          await decision.mutateAsync({ id: driver.id, decision: 'approve' });
          toast({ tone: 'success', title: 'Conductor aprobado' });
        }}
      />
      {/* El rechazo lleva MOTIVO: identity-service lo persiste, emite driver.rejected y el conductor lo VE
          en su app (pantalla de rechazo) para corregir-y-reenviar. El motivo es obligatorio en la UI. */}
      <ConfirmDialog
        trigger={
          <Button size="sm" variant="secondary">
            <X className="size-4" aria-hidden />
            Rechazar
          </Button>
        }
        title="Rechazar conductor"
        description={`Se rechazará al conductor ${driver.id.slice(0, 8)}. El motivo se le mostrará para que corrija y reenvíe. La acción queda auditada.`}
        confirmLabel="Rechazar"
        variant="danger"
        withReason
        reasonLabel="Motivo del rechazo (visible para el conductor)"
        onConfirm={async (reason) => {
          await decision.mutateAsync({ id: driver.id, decision: 'reject', reason });
          toast({ tone: 'success', title: 'Conductor rechazado' });
        }}
      />
    </div>
  );
}
