'use client';

import { Check, ShieldCheck } from 'lucide-react';
import type { DriverApproval } from '@/lib/api/schemas';
import { useDriverDecision } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { StepUpDialog } from '@/components/security/step-up-dialog';

/**
 * Re-aprobar un conductor RECHAZADO (apelación/corrección revisada por el operador). Cierra el otro
 * extremo del dead-end: además del resubmit que el conductor dispara desde su app, el operador puede
 * re-aprobar directamente (REJECTED → CLEARED, transición que la máquina de identity ya permite).
 * Gated por `drivers:approve`; el admin-bff revalida @Roles server-side (la UI no autoriza).
 */
export function RejectedDriverActions({ driver }: { driver: DriverApproval }) {
  const user = useSession();
  const { toast } = useToast();
  const decision = useDriverDecision();

  if (!can(user, 'drivers:approve')) {
    return <span className="text-xs text-ink-subtle">—</span>;
  }

  return (
    <StepUpDialog
      trigger={
        <Button size="sm" variant="primary">
          <Check className="size-4" aria-hidden />
          Re-aprobar
        </Button>
      }
      title="Confirmá tu identidad"
      icon={ShieldCheck}
      description={`Re-aprobar al conductor ${driver.id.slice(0, 8)} (antecedentes CLEARED) · acción sensible. Ingresá tu código TOTP (BR-S07). Queda auditada.`}
      confirmLabel="Confirmar aprobación"
      onVerified={async () => {
        await decision.mutateAsync({ id: driver.id, decision: 'approve' });
        toast({ tone: 'success', title: 'Conductor re-aprobado' });
      }}
    />
  );
}
