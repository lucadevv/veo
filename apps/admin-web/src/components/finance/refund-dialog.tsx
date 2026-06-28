'use client';

import { useRef, useState } from 'react';
import { Undo2 } from 'lucide-react';
import { solesToCents } from '@veo/utils/money';
import { useRefund } from '@/lib/api/queries';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { StepUpDialog } from '@/components/security/step-up-dialog';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

/** Motivo mínimo: el DTO del admin-bff exige MinLength(3). Validar acá evita un 400 en el round-trip. */
const REASON_MIN_LENGTH = 3;

/** Emite un reembolso sobre un viaje (monto en soles → céntimos). Idempotente. */
export function RefundDialog() {
  const { toast } = useToast();
  const refund = useRefund();
  const [open, setOpen] = useState(false);
  const [tripId, setTripId] = useState('');
  const [soles, setSoles] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Idempotency-Key ligado a la IDENTIDAD DE DINERO de la operación: SOLO (tripId, céntimos). El motivo (texto
  // libre) NO entra — el dinero lo define el viaje y el monto; editar el motivo no es una operación distinta, y
  // meterlo en el key haría que un retype cosmético del motivo derrote el dedup y doble-pague. Cacheado por firma:
  //  - misma firma → MISMO key → un reintento (retipear igual, editar el motivo, cerrar+reabrir+reenviar) dedupea
  //    server-side y NO doble-paga.
  //  - firma distinta (otro viaje o monto) → key NUEVO → otra operación.
  // Se resetea SOLO en ÉXITO (no al abrir): así dos reembolsos parciales LEGÍTIMOS idénticos NO colapsan (el 1ro
  // hace SUCCESS → reset → el 2do arranca con key fresco), pero un reintento de una op aún NO confirmada conserva
  // el key (la única forma de doble-pagar el MISMO valor sería tras un éxito confirmado, que es intencional).
  const attemptRef = useRef<{ sig: string; key: string } | null>(null);

  const amount = Number(soles);
  const valid =
    tripId.trim().length > 0 && amount > 0 && reason.trim().length >= REASON_MIN_LENGTH;

  /** Key idempotente de ESTE intento: estable mientras (tripId, céntimos) no cambie; fresco si cambian. */
  function operationKey(amountCents: number): string {
    const sig = `${tripId.trim()}|${amountCents}`;
    if (!attemptRef.current || attemptRef.current.sig !== sig) {
      attemptRef.current = { sig, key: crypto.randomUUID() };
    }
    return attemptRef.current.key;
  }

  function handleOpenChange(next: boolean) {
    if (next) setError(null);
    setOpen(next);
  }

  async function submit() {
    setError(null);
    const amountCents = solesToCents(amount);
    try {
      await refund.mutateAsync({
        tripId: tripId.trim(),
        amountCents,
        reason: reason.trim(),
        idempotencyKey: operationKey(amountCents),
      });
      attemptRef.current = null; // éxito: la próxima operación (aunque repita valores) arranca con key fresco
      toast({ tone: 'success', title: 'Reembolso emitido' });
      setOpen(false);
      setTripId('');
      setSoles('');
      setReason('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo emitir el reembolso.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          <Undo2 className="size-4" aria-hidden />
          Emitir reembolso
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Emitir reembolso</DialogTitle>
          <DialogDescription>
            Reintegro al pasajero sobre un viaje. El monto se procesa en soles.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="ID de viaje">
            <Input
              value={tripId}
              onChange={(e) => setTripId(e.target.value)}
              placeholder="UUID del viaje"
            />
          </Field>
          <Field label="Monto (S/)">
            <Input
              inputMode="decimal"
              value={soles}
              onChange={(e) => setSoles(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder="0.00"
            />
          </Field>
          <Field label="Motivo" error={error ?? undefined}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancelar</Button>
          </DialogClose>
          <StepUpDialog
            title="Emitir reembolso"
            description="Reintegro al pasajero sobre un viaje. Es una acción money-OUT: confirmá con tu código TOTP (step-up MFA). El admin-bff lo exige server-side."
            trigger={
              <Button
                variant="primary"
                loading={refund.isPending}
                // El Button auto-deshabilita en `loading` (`disabled || loading`), así que acá solo gateamos por
                // `!valid`. Deshabilitado bloquea también la apertura del step-up (DialogTrigger respeta disabled).
                disabled={!valid}
              >
                Emitir reembolso
              </Button>
            }
            onVerified={submit}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
