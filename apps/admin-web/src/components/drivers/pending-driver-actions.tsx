'use client';

import { AlertTriangle, Check, ShieldCheck, X } from 'lucide-react';
import { useDriverDecision } from '@/lib/api/queries';
import type { PendingDriver } from '@/lib/api/schemas';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { StepUpDialog } from '@/components/security/step-up-dialog';

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
      {/* Aprobar exige step-up MFA (BR-S07 · @RequireStepUpMfa en el bff): en prod pide el TOTP, en dev lo salta
          (espeja el StepUpMfaGuard). Con ConfirmDialog el approve fallaba 403 en prod (MFA no fresca). */}
      <StepUpDialog
        trigger={
          <Button size="sm" variant="primary">
            <Check className="size-4" aria-hidden />
            Aprobar
          </Button>
        }
        title="Confirmá tu identidad"
        icon={ShieldCheck}
        description={`Aprobar conductor ${driver.id.slice(0, 8)} · acción sensible. Ingresá el código de tu app (TOTP); la aprobación exige verificación fresca (BR-S07).`}
        confirmLabel="Confirmar aprobación"
        onVerified={async () => {
          await decision.mutateAsync({ id: driver.id, decision: 'approve' });
          toast({ tone: 'success', title: 'Conductor aprobado' });
        }}
      />
      {/* Rechazar: MOTIVO (el conductor lo VE en su app para corregir y reenviar) + MFA (BR-S07). El motivo
          viaja en driver.rejected; identity lo persiste. El StepUpDialog captura ambos en un solo modal. */}
      <StepUpDialog
        trigger={
          <Button size="sm" variant="secondary">
            <X className="size-4" aria-hidden />
            Rechazar
          </Button>
        }
        title="Rechazar alta"
        icon={AlertTriangle}
        description={`El conductor ${driver.id.slice(0, 8)} recibirá el motivo, podrá corregir y reenviar a revisión. Requiere tu MFA. Queda auditado.`}
        confirmLabel="Rechazar alta"
        confirmVariant="danger"
        withReason
        reasonLabel="Motivo del rechazo (visible para el conductor)"
        reasonPlaceholder="Ej. La foto de la licencia no es legible. Vuelve a capturarla con buena luz."
        onVerified={async (reason) => {
          await decision.mutateAsync({ id: driver.id, decision: 'reject', reason });
          toast({ tone: 'success', title: 'Conductor rechazado' });
        }}
      />
    </div>
  );
}
