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

/**
 * Prefijo del slot de sessionStorage donde vive el nonce idempotente de un intento de reembolso, ligado a la
 * firma (tripId, céntimos). Ver el comentario de `operationKey` para el porqué del store y su residual.
 */
const ATTEMPT_SLOT_PREFIX = 'veo:refund-attempt:';

/** Slot de sessionStorage para la firma (tripId, céntimos) de ESTE intento. */
function attemptSlot(tripId: string, amountCents: number): string {
  return `${ATTEMPT_SLOT_PREFIX}${tripId.trim()}|${amountCents}`;
}

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
  // DURABILIDAD (Lote 8): el nonce vive en sessionStorage, NO en un useRef efímero. El escenario que el diseño
  // dice cubrir (submit → timeout de red → el operador REFRESCA o navega y vuelve) DESMONTA el componente y vacía
  // un useRef → se re-acuñaba un UUID nuevo → segundo money-OUT del MISMO dinero (ALTA cazada por el gate de
  // convergencia). sessionStorage liga el nonce a (tripId, céntimos) y lo conserva a través del remonte/refresh
  // de ESTA sesión de pestaña hasta el ÉXITO confirmado.
  // Se limpia SOLO en ÉXITO (no al abrir): así dos reembolsos parciales LEGÍTIMOS idénticos NO colapsan (el 1ro
  // hace SUCCESS → se limpia el slot → el 2do arranca con key fresco), pero un reintento de una op aún NO
  // confirmada conserva el key (la única forma de doble-pagar el MISMO valor sería tras un éxito confirmado, que
  // es intencional). RESIDUAL IRREDUCIBLE: otra pestaña / otro dispositivo NO comparten sessionStorage — cerrar
  // ESE caso necesita un backstop server-side con ventana temporal + un gesto explícito de "es un reembolso
  // nuevo" (sin él, el server no puede distinguir un reintento de un parcial-igual legítimo). Decisión de producto.
  const attemptRef = useRef<{ sig: string; key: string } | null>(null);

  const amount = Number(soles);
  const valid =
    tripId.trim().length > 0 && amount > 0 && reason.trim().length >= REASON_MIN_LENGTH;

  /** Key idempotente de ESTE intento: estable mientras (tripId, céntimos) no cambie; sobrevive remonte/refresh. */
  function operationKey(amountCents: number): string {
    const sig = `${tripId.trim()}|${amountCents}`;
    // Camino real (cliente): el nonce persiste en sessionStorage atado a la firma → un remonte/refresh lo reusa.
    if (typeof window !== 'undefined') {
      const slot = attemptSlot(tripId, amountCents);
      const existing = window.sessionStorage.getItem(slot);
      if (existing) return existing;
      const key = crypto.randomUUID();
      window.sessionStorage.setItem(slot, key);
      return key;
    }
    // SSR / sin storage: degradación honesta al ref efímero (no crashea; la persistencia recién aplica en cliente).
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
      // éxito: limpiar el nonce (sessionStorage + ref) → la próxima operación, aunque repita valores, arranca
      // con key fresco; así dos parciales legítimos idénticos NO se colapsan.
      if (typeof window !== 'undefined') {
        window.sessionStorage.removeItem(attemptSlot(tripId, amountCents));
      }
      attemptRef.current = null;
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
