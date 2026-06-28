'use client';

import { useEffect, useState } from 'react';
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
  // Idempotency-Key ligado a la IDENTIDAD de la operación (tripId, monto, motivo), NO a la sesión del diálogo:
  // se re-acuña cuando CUALQUIERA cambia. Por qué importa: si el operador reembolsa el trip A, ve un error de
  // red ambiguo (el server pudo haber commiteado) y SIN cerrar el diálogo edita el tripId/monto y reenvía, eso
  // es OTRA operación → key nuevo → NO se dedupea al refund de A (que server-side devolvería un refund ajeno
  // como éxito falso → el nuevo viaje nunca se reembolsa). Si reintenta SIN cambiar nada → mismo key → dedup.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const amount = Number(soles);
  const valid =
    tripId.trim().length > 0 && amount > 0 && reason.trim().length >= REASON_MIN_LENGTH;

  useEffect(() => {
    setIdempotencyKey(crypto.randomUUID());
  }, [tripId, soles, reason]);

  function handleOpenChange(next: boolean) {
    if (next) setError(null);
    setOpen(next);
  }

  async function submit() {
    setError(null);
    try {
      await refund.mutateAsync({
        tripId: tripId.trim(),
        amountCents: solesToCents(amount),
        reason: reason.trim(),
        idempotencyKey,
      });
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
                // `!valid || isPending`: `disabled` es un booleano DEFINIDO, así que el `disabled ?? loading`
                // del Button no caería a `loading` solo — hay que OR-ear el pending acá para que el botón NO
                // siga clickeable durante el request (si no, un doble-click dispara dos submits). Y deshabilitado
                // bloquea también la apertura del step-up (DialogTrigger respeta disabled).
                disabled={!valid || refund.isPending}
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
