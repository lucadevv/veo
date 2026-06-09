'use client';

import { PlayCircle } from 'lucide-react';
import { useRunPayout } from '@/lib/api/queries';
import { money } from '@/lib/formatters';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/**
 * Ejecuta el BATCH de liquidaciones del periodo (semana previa). NO es por-payout: el backend agrega los
 * cobros capturados de cada conductor y liquida toda la semana de una. Idempotente (Idempotency-Key);
 * >S/5000 exige step-up MFA (lo valida payment-service). Gated por finance:payout (solo FINANCE).
 */
export function RunPayoutsButton() {
  const { toast } = useToast();
  const run = useRunPayout();

  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="primary">
          <PlayCircle className="size-4" aria-hidden />
          Ejecutar liquidaciones
        </Button>
      }
      title="Ejecutar liquidaciones del periodo"
      description="Se liquida la semana previa: se agregan los cobros capturados de cada conductor y se transfieren. Los conductores en revisión quedan retenidos (HELD). La acción es idempotente."
      confirmLabel="Ejecutar batch"
      onConfirm={async () => {
        const res = await run.mutateAsync({ idempotencyKey: crypto.randomUUID() });
        toast({
          tone: 'success',
          title: `Liquidación ejecutada: ${res.processed} pagadas, ${res.held} retenidas`,
          description: `Total transferido ${money(res.totalAmountCents)}`,
        });
      }}
    />
  );
}
