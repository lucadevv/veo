'use client';

import { Check, CircleX, ShieldCheck } from 'lucide-react';
import { useApproveRefund, useRejectRefund } from '@/lib/api/queries';
import { money } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { StepUpDialog } from '@/components/security/step-up-dialog';

/**
 * APRUEBA + desembolsa un reembolso PENDING (money-OUT). Solo visible sobre filas PENDING y con `finance:refund`
 * (espejo del @Permission del bff; la UI refleja, el servidor autoriza). El desembolso exige step-up MFA fresco:
 * el StepUpDialog lo asegura ANTES de invocar (en dev se salta el TOTP, igual que el StepUpMfaGuard del backend).
 * Idempotente.
 */
export function ApproveRefundButton({
  refundId,
  amountCents,
}: {
  refundId: string;
  amountCents: number;
}) {
  const user = useSession();
  const { toast } = useToast();
  const approve = useApproveRefund();

  if (!can(user, 'finance:refund')) return null;

  return (
    <StepUpDialog
      icon={ShieldCheck}
      title="Aprobar y desembolsar el reembolso"
      description={`Se aprueba la solicitud y su plata sale por el riel (${money(amountCents)}; se confirma cuando el proveedor responde). La acción es idempotente. Confirmá con tu código TOTP (step-up MFA).`}
      confirmLabel="Aprobar"
      trigger={
        <Button size="sm" variant="primary" loading={approve.isPending}>
          <Check className="size-4" aria-hidden />
          Aprobar
        </Button>
      }
      onVerified={async () => {
        await approve.mutateAsync({ id: refundId });
        toast({
          tone: 'success',
          title: 'Reembolso aprobado',
          description: 'El desembolso salió por el riel; se confirma cuando el proveedor responde.',
        });
      }}
    />
  );
}

/**
 * RECHAZA un reembolso PENDING (NO mueve plata). Reusa el patrón del T/RejectModal del frame: motivo (textarea)
 * + Cancelar/Rechazar, con el step-up MFA en el mismo diálogo (`withReason`). El motivo es OBLIGATORIO (≥3) y
 * queda auditado. Solo visible sobre filas PENDING y con `finance:refund`. Idempotente.
 */
export function RejectRefundButton({ refundId }: { refundId: string }) {
  const user = useSession();
  const { toast } = useToast();
  const reject = useRejectRefund();

  if (!can(user, 'finance:refund')) return null;

  return (
    <StepUpDialog
      icon={CircleX}
      title="Rechazar el reembolso"
      description="Indicá el motivo. Queda registrado en auditoría y no se mueve plata. La acción es idempotente."
      confirmLabel="Rechazar"
      confirmVariant="danger"
      withReason
      reasonLabel="Motivo del rechazo"
      reasonPlaceholder="Motivo del rechazo…"
      trigger={
        <Button size="sm" variant="secondary" loading={reject.isPending}>
          <CircleX className="size-4 text-danger" aria-hidden />
          Rechazar
        </Button>
      }
      onVerified={async (reason) => {
        await reject.mutateAsync({ id: refundId, reason: reason ?? '' });
        toast({ tone: 'success', title: 'Reembolso rechazado' });
      }}
    />
  );
}
