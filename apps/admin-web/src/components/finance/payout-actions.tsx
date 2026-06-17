'use client';

import { LockOpen, PlayCircle } from 'lucide-react';
import { useReleaseDriverPayouts, useRunPayout } from '@/lib/api/queries';
import { money } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
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

/**
 * Libera la RETENCIÓN de un conductor (camino de vuelta de driver.flagged): sus payouts HELD pasan a
 * PROCESSED (la plata sale) y las próximas liquidaciones ya no nacen retenidas. Acción por-conductor,
 * visible solo sobre filas HELD. Gated por finance:payout (solo FINANCE — espejo del @Roles del bff);
 * el backend exige además step-up MFA si el total liberado supera S/5000 (BR-S07). Idempotente.
 */
export function ReleaseHeldPayoutButton({
  driverId,
  amountCents,
}: {
  driverId: string;
  amountCents: number;
}) {
  const user = useSession();
  const { toast } = useToast();
  const release = useReleaseDriverPayouts();

  if (!can(user, 'finance:payout')) return null;

  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="secondary">
          <LockOpen className="size-4" aria-hidden />
          Liberar retención
        </Button>
      }
      title="Liberar la retención del conductor"
      description={`Se levantará la retención (review resuelto): TODOS los payouts HELD del conductor se procesan y se transfiere su plata (esta liquidación: ${money(amountCents)}). Las próximas liquidaciones ya no nacerán retenidas. La acción es idempotente.`}
      confirmLabel="Liberar y pagar"
      onConfirm={async () => {
        await release.mutateAsync({ driverId });
        toast({
          tone: 'success',
          title: 'Retención liberada',
          description:
            'Los payouts HELD del conductor fueron procesados y la retención se levantó.',
        });
      }}
    />
  );
}
