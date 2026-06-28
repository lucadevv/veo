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

/**
 * Lectura tolerante del nonce persistido. Si el storage NO está disponible (SSR, modo administrado/privado que
 * LANZA al acceder) devuelve null sin reventar — el reembolso NUNCA se bloquea por un storage caído (mismo patrón
 * que theme.tsx). Devolver null hace que el caller acuñe/use el ref efímero.
 */
function readNonce(slot: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(slot);
  } catch {
    return null;
  }
}

/** Escritura tolerante del nonce: si el storage lanza, no pasa nada (el caller ya tiene el key en mano/ref). */
function writeNonce(slot: string, key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(slot, key);
  } catch {
    /* storage bloqueado: el nonce no sobrevive el remonte, pero el flujo de dinero sigue */
  }
}

/** Borrado tolerante del nonce (tras éxito confirmado): un storage caído jamás disfraza un money-OUT exitoso. */
function clearNonce(slot: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(slot);
  } catch {
    /* storage bloqueado: un nonce huérfano no afecta la integridad de dinero */
  }
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
  // Gesto EXPLÍCITO "es un reembolso NUEVO, no un reintento": habilita un 2do parcial idéntico legítimo. El server
  // no puede distinguir un reintento de un parcial-igual sin esta señal, así que la decide el operador (humano).
  const [forceNew, setForceNew] = useState(false);
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

  /**
   * Key idempotente de ESTE intento: estable mientras (tripId, céntimos) no cambie; sobrevive remonte/refresh vía
   * sessionStorage. Es TOTAL — NUNCA lanza: si el storage está caído (administrado/privado) degrada al ref efímero
   * (el nonce no persiste el remonte, pero el reembolso JAMÁS queda bloqueado por un storage inaccesible).
   */
  function operationKey(amountCents: number): string {
    const sig = `${tripId.trim()}|${amountCents}`;
    const slot = attemptSlot(tripId, amountCents);
    // Camino real (cliente): el nonce persiste en sessionStorage atado a la firma → un remonte/refresh lo reusa.
    const persisted = readNonce(slot);
    if (persisted) return persisted;
    // No hay nonce persistido aún. Acuñamos uno, lo intentamos persistir (tolerante) y lo espejamos en el ref por
    // si el storage no lo guardó: así el MISMO render reusa el mismo key aunque sessionStorage esté bloqueado.
    if (!attemptRef.current || attemptRef.current.sig !== sig) {
      attemptRef.current = { sig, key: crypto.randomUUID() };
    }
    writeNonce(slot, attemptRef.current.key);
    return attemptRef.current.key;
  }

  function handleOpenChange(next: boolean) {
    if (next) setError(null);
    setOpen(next);
  }

  async function submit() {
    setError(null);
    const amountCents = solesToCents(amount);
    // "Reembolso nuevo" deliberado: descartar el nonce persistido ANTES de acuñar el key, para que salga uno
    // FRESCO. Si no, el `dedupKey` server-side devolvería el refund anterior y derrotaría el `forceNew` (el
    // backstop de ventana lo salta el flag, pero la barrera dura del key seguiría dedupeando con el mismo key).
    if (forceNew) {
      clearNonce(attemptSlot(tripId, amountCents));
      attemptRef.current = null;
    }
    // El try cubre SOLO la mutación money-OUT: si falla, es el ÚNICO caso en que mostramos "no se pudo emitir".
    try {
      await refund.mutateAsync({
        tripId: tripId.trim(),
        amountCents,
        reason: reason.trim(),
        idempotencyKey: operationKey(amountCents),
        forceNew,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo emitir el reembolso.');
      return;
    }
    // money-OUT CONFIRMADO: nada de acá abajo puede "fallar el reembolso" (el dinero YA se movió), por eso vive
    // FUERA del try. Limpiar el nonce → la próxima operación, aunque repita valores, arranca con key fresco (dos
    // parciales legítimos idénticos NO colapsan). clearNonce es tolerante a storage caído.
    clearNonce(attemptSlot(tripId, amountCents));
    attemptRef.current = null;
    toast({ tone: 'success', title: 'Reembolso emitido' });
    setOpen(false);
    setTripId('');
    setSoles('');
    setReason('');
    setForceNew(false);
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
          <label htmlFor="refund-force-new" className="flex items-start gap-2.5 text-sm">
            <input
              id="refund-force-new"
              type="checkbox"
              checked={forceNew}
              onChange={(e) => setForceNew(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 rounded border-border accent-accent"
            />
            <span>
              Es un reembolso nuevo, no un reintento
              <span className="mt-0.5 block text-ink-muted">
                Marcá esto solo si querés emitir un segundo reembolso idéntico (mismo viaje y monto) a propósito.
                Por defecto, un reenvío del mismo monto se trata como reintento y no duplica el pago.
              </span>
            </span>
          </label>
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
