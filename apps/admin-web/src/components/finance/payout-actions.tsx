'use client';

import { LockOpen, PlayCircle, RotateCcw } from 'lucide-react';
import { useReleaseDriverPayouts, useRetryPayout, useRunPayout } from '@/lib/api/queries';
import { money } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { StepUpDialog } from '@/components/security/step-up-dialog';

/**
 * Ejecuta el BATCH de liquidaciones del periodo (semana previa). NO es por-payout: el backend agrega los
 * cobros capturados de cada conductor y liquida toda la semana de una. Idempotente (Idempotency-Key);
 * >S/5000 exige step-up MFA (lo valida payment-service). Gated por finance:payout (solo FINANCE).
 */
export function RunPayoutsButton() {
  const { toast } = useToast();
  const run = useRunPayout();

  return (
    <StepUpDialog
      trigger={
        <Button size="sm" variant="primary">
          <PlayCircle className="size-4" aria-hidden />
          Ejecutar liquidaciones
        </Button>
      }
      title="Ejecutar liquidaciones del periodo"
      description="Se liquida la semana previa: se agregan los cobros capturados de cada conductor y se DESEMBOLSAN al riel (la plata queda en camino; se confirma cuando el riel responde). Los conductores en revisión quedan retenidos (HELD). La acción es idempotente. Confirmá con tu código TOTP (step-up MFA)."
      onVerified={async () => {
        const res = await run.mutateAsync({ idempotencyKey: crypto.randomUUID() });
        toast({
          tone: 'success',
          title:
            res.failed > 0
              ? `Liquidación disparada: ${res.dispatched} en camino, ${res.failed} rechazadas por el riel`
              : `Liquidación disparada: ${res.dispatched} desembolso(s) en camino`,
          description: `Total en camino ${money(res.totalAmountCents)} (se confirma cuando el riel responde)`,
        });
      }}
    />
  );
}

/**
 * Libera la RETENCIÓN de un conductor (camino de vuelta de driver.flagged): sus payouts HELD entran al
 * desembolso (HELD→PROCESSING, la plata sale por el riel y se confirma luego) y las próximas liquidaciones
 * ya no nacen retenidas. Acción por-conductor, visible solo sobre filas HELD. Gated por finance:payout
 * (solo FINANCE — espejo del @Roles del bff); el backend exige además step-up MFA si el total liberado
 * supera S/5000 (BR-S07). Idempotente.
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
    <StepUpDialog
      trigger={
        <Button size="sm" variant="secondary">
          <LockOpen className="size-4" aria-hidden />
          Liberar retención
        </Button>
      }
      title="Liberar la retención del conductor"
      description={`Se levantará la retención (review resuelto): TODOS los payouts HELD del conductor entran al desembolso y su plata sale por el riel (esta liquidación: ${money(amountCents)}; se confirma cuando el riel responde). Las próximas liquidaciones ya no nacerán retenidas. La acción es idempotente. Confirmá con tu código TOTP (step-up MFA).`}
      onVerified={async () => {
        await release.mutateAsync({ driverId });
        toast({
          tone: 'success',
          title: 'Retención liberada',
          description:
            'Los payouts HELD del conductor entraron al desembolso y la retención se levantó.',
        });
      }}
    />
  );
}

/**
 * Reintenta un payout FALLIDO (ADR-015 §5): FAILED→PROCESSING re-entra al desembolso de forma idempotente
 * por dedupKey (el riel NO doble-paga si la salida anterior sí llegó a despacharse). Acción por-payout,
 * visible solo sobre filas FAILED. Gated por finance:payout (solo FINANCE — espejo del @Roles del bff); el
 * backend exige además step-up MFA si el monto supera S/5000 (BR-S07). Idempotente.
 */
export function RetryPayoutButton({
  payoutId,
  amountCents,
}: {
  payoutId: string;
  amountCents: number;
}) {
  const user = useSession();
  const { toast } = useToast();
  const retry = useRetryPayout();

  if (!can(user, 'finance:payout')) return null;

  return (
    <StepUpDialog
      trigger={
        <Button size="sm" variant="secondary">
          <RotateCcw className="size-4" aria-hidden />
          Reintentar
        </Button>
      }
      title="Reintentar liquidación"
      description={`El payout FALLIDO vuelve al desembolso (FAILED→PROCESSING) y su plata sale de nuevo por el riel (${money(amountCents)}; se confirma cuando el riel responde). La acción es idempotente por dedupKey: el riel NO doble-paga si la salida anterior sí se despachó. Confirmá con tu código TOTP (step-up MFA).`}
      onVerified={async () => {
        const res = await retry.mutateAsync({ payoutId, idempotencyKey: crypto.randomUUID() });
        toast({
          tone: 'success',
          title:
            res.failed > 0
              ? 'Reintento rechazado por el riel'
              : 'Reintento disparado: desembolso en camino',
          description:
            res.failed > 0
              ? `El riel rechazó el reintento (${money(res.totalAmountCents)}). Revisá el estado del payout.`
              : `Total en camino ${money(res.totalAmountCents)} (se confirma cuando el riel responde).`,
        });
      }}
    />
  );
}
