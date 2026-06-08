'use client';

import { PlayCircle } from 'lucide-react';
import { useRunPayout } from '@/lib/api/queries';
import type { PayoutView } from '@/lib/api/schemas';
import { money } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/** Ejecuta una liquidación con confirmación e idempotencia (gated por finance:payout). */
export function PayoutActions({ payout }: { payout: PayoutView }) {
  const user = useSession();
  const { toast } = useToast();
  const run = useRunPayout();

  if (!can(user, 'finance:payout') || payout.status.toUpperCase() !== 'PENDING') {
    return <span className="text-xs text-ink-subtle">—</span>;
  }

  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="primary">
          <PlayCircle className="size-4" aria-hidden />
          Ejecutar
        </Button>
      }
      title="Ejecutar liquidación"
      description={`Se transferirá ${money(payout.amountCents)} al conductor ${payout.driverId.slice(0, 8)} (periodo ${payout.period}). Esta acción es idempotente.`}
      confirmLabel="Ejecutar pago"
      onConfirm={async () => {
        await run.mutateAsync({ id: payout.id, idempotencyKey: crypto.randomUUID() });
        toast({ tone: 'success', title: 'Liquidación ejecutada' });
      }}
    />
  );
}
