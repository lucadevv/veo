'use client';

import { Check, X } from 'lucide-react';
import { useDocumentReview } from '@/lib/api/queries';
import type { FleetDocumentView } from '@/lib/api/schemas';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/** Revisión documental (aprobar/rechazar), gated por fleet:review. */
export function DocumentActions({ doc }: { doc: FleetDocumentView }) {
  const user = useSession();
  const { toast } = useToast();
  const review = useDocumentReview();

  if (!can(user, 'fleet:review') || doc.status.toUpperCase() !== 'PENDING') {
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
        title="Aprobar documento"
        description="Confirmas que el documento es válido y vigente."
        confirmLabel="Aprobar"
        onConfirm={async () => {
          await review.mutateAsync({ id: doc.id, decision: 'approve' });
          toast({ tone: 'success', title: 'Documento aprobado' });
        }}
      />
      <ConfirmDialog
        trigger={
          <Button size="sm" variant="secondary">
            <X className="size-4" aria-hidden />
            Rechazar
          </Button>
        }
        title="Rechazar documento"
        description="Indica el motivo del rechazo."
        confirmLabel="Rechazar"
        variant="danger"
        withReason
        reasonLabel="Motivo"
        onConfirm={async (reason) => {
          await review.mutateAsync({ id: doc.id, decision: 'reject', reason });
          toast({ tone: 'success', title: 'Documento rechazado' });
        }}
      />
    </div>
  );
}
