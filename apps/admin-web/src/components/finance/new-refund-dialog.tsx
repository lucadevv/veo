'use client';

import { useRef, useState } from 'react';
import { Plus, Search, Undo2, User, Car } from 'lucide-react';
import { solesToCents } from '@veo/utils/money';
import { usePaymentByTrip, useRequestRefund } from '@/lib/api/queries';
import type { RefundablePaymentView } from '@/lib/api/schemas';
import { money } from '@/lib/formatters';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { StepUpDialog } from '@/components/security/step-up-dialog';
import { RefundMethodCell } from '@/components/finance/refund-method';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

const REASON_MIN_LENGTH = 3;

/** El backstop de VENTANA del server (2do parcial idéntico) rebota con este mensaje → habilita el "forzar". */
function isDuplicateWindowError(message: string): boolean {
  return /reembolso reciente/i.test(message) || /ventana de idempotencia/i.test(message);
}

// ── Idempotencia del money-OUT: nonce ligado a (tripId, céntimos) en sessionStorage, sobrevive remonte/refresh
// hasta el ÉXITO. Tolerante a storage caído (nunca bloquea el reembolso). ──
const ATTEMPT_SLOT_PREFIX = 'veo:refund-attempt:';
const attemptSlot = (tripId: string, cents: number) =>
  `${ATTEMPT_SLOT_PREFIX}${tripId.trim()}|${cents}`;
function readNonce(slot: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(slot);
  } catch {
    return null;
  }
}
function writeNonce(slot: string, key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(slot, key);
  } catch {
    /* storage bloqueado: el flujo de dinero sigue */
  }
}
function clearNonce(slot: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(slot);
  } catch {
    /* noop */
  }
}

/** Fila etiqueta→valor de la card del cobro. */
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1 text-sm">
      <span className="text-ink-muted">{label}</span>
      <span className="text-right text-ink">{children}</span>
    </div>
  );
}

/** Resumen del cobro reembolsable + el formulario para SOLICITAR (crea PENDING, no desembolsa). */
function RequestForm({ payment, onDone }: { payment: RefundablePaymentView; onDone: () => void }) {
  const { toast } = useToast();
  const request = useRequestRefund();
  const [mode, setMode] = useState<'TOTAL' | 'PARCIAL'>('TOTAL');
  const [soles, setSoles] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  // El server rebotó por el backstop de ventana (parcial idéntico reciente). Habilita un "forzar" DELIBERADO
  // (segundo submit con forceNew) para el caso legítimo de un 2do reembolso parcial distinto.
  const [forceable, setForceable] = useState(false);
  const attemptRef = useRef<{ sig: string; key: string } | null>(null);

  const amountCents =
    mode === 'TOTAL' ? payment.refundableCents : Math.round(solesToCents(Number(soles) || 0));
  const amountOk = amountCents > 0 && amountCents <= payment.refundableCents;
  const valid = amountOk && reason.trim().length >= REASON_MIN_LENGTH;

  function operationKey(cents: number): string {
    const sig = `${payment.tripId}|${cents}`;
    const slot = attemptSlot(payment.tripId, cents);
    const persisted = readNonce(slot);
    if (persisted) return persisted;
    if (attemptRef.current?.sig !== sig) {
      attemptRef.current = { sig, key: crypto.randomUUID() };
    }
    writeNonce(slot, attemptRef.current.key);
    return attemptRef.current.key;
  }

  async function submit(force = false) {
    setError(null);
    let res: Awaited<ReturnType<typeof request.mutateAsync>>;
    try {
      res = await request.mutateAsync({
        tripId: payment.tripId,
        amountCents,
        reason: reason.trim(),
        idempotencyKey: operationKey(amountCents),
        forceNew: force,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'No se pudo crear la solicitud.';
      // Belt-and-suspenders: si el server llegara a REBOTAR por la ventana (en vez del flag deduped) y NO
      // veníamos forzando, igual ofrecemos el "forzar" deliberado.
      setForceable(!force && isDuplicateWindowError(message));
      setError(message);
      return;
    }
    // El server NO creó una solicitud nueva: devolvió una RECIENTE existente (backstop de ventana). No mentimos
    // "creada" — ofrecemos el "forzar" deliberado para el 2do parcial legítimo distinto. NO limpiamos el nonce
    // (el forzar re-usa el flujo con forceNew).
    if (res.deduped && !force) {
      setForceable(true);
      setError(
        'Ya existe un reembolso reciente para este pago y monto. Si es uno DISTINTO, forzá uno nuevo.',
      );
      return;
    }
    clearNonce(attemptSlot(payment.tripId, amountCents));
    attemptRef.current = null;
    setForceable(false);
    toast({
      tone: 'success',
      title: 'Solicitud creada',
      description: 'Entró a la cola de aprobación (aún no desembolsa).',
    });
    onDone();
  }

  return (
    <div className="space-y-4">
      {/* Resumen del cobro (contexto de la solicitud). */}
      <div className="space-y-1 rounded-lg border border-border bg-surface-2 p-4">
        <InfoRow label="Método">
          <RefundMethodCell method={payment.method} />
        </InfoRow>
        <InfoRow label="Pasajero">
          <span className="inline-flex items-center gap-1.5 font-mono text-xs text-ink-muted">
            <User className="size-3.5" aria-hidden />
            {payment.passengerId ? `${payment.passengerId.slice(0, 8)}…` : '—'}
          </span>
        </InfoRow>
        <InfoRow label="Conductor">
          <span className="inline-flex items-center gap-1.5 font-mono text-xs text-ink-muted">
            <Car className="size-3.5" aria-hidden />
            {payment.driverId ? `${payment.driverId.slice(0, 8)}…` : '—'}
          </span>
        </InfoRow>
        <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
          <span className="text-sm font-medium text-ink-muted">Reembolsable</span>
          <span className="tabular text-xl font-semibold text-ink">
            {money(payment.refundableCents)}
          </span>
        </div>
      </div>

      {/* Total / Parcial */}
      <div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5">
        {(['TOTAL', 'PARCIAL'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              'rounded px-3 py-1 text-sm font-medium transition-colors',
              mode === m ? 'bg-brand/15 text-brand' : 'text-ink-muted hover:text-ink',
            )}
          >
            {m === 'TOTAL' ? 'Total' : 'Parcial'}
          </button>
        ))}
      </div>

      <Field label="Monto (S/)">
        {mode === 'TOTAL' ? (
          <div className="tabular rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-ink">
            {money(payment.refundableCents)}
          </div>
        ) : (
          <input
            inputMode="decimal"
            value={soles}
            onChange={(e) => setSoles(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0.00"
            className="tabular w-full rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-ink placeholder:text-ink-subtle focus:border-brand focus:outline-none"
          />
        )}
      </Field>

      <Field label="Motivo" error={error ?? undefined}>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="Detalle visible para el pasajero…"
          className="resize-none"
        />
      </Field>

      <StepUpDialog
        title="Solicitar reembolso"
        description="Crea la solicitud PENDING (entra a la cola de aprobación; NO desembolsa hasta aprobar). Confirmá con tu código TOTP (step-up MFA)."
        confirmLabel="Solicitar"
        trigger={
          <Button variant="primary" className="w-full" loading={request.isPending} disabled={!valid}>
            Solicitar {money(amountCents)}
          </Button>
        }
        onVerified={() => submit(false)}
      />

      {/* Forzar: el server marcó un parcial idéntico reciente. Si es un reembolso DISTINTO y legítimo (no un
          reintento), el operador lo confirma explícitamente y se re-envía con forceNew (salta el backstop). */}
      {forceable ? (
        <StepUpDialog
          title="Forzar un reembolso distinto"
          description="El sistema detectó un reembolso reciente idéntico (ventana de idempotencia). Si este es un reembolso DISTINTO y legítimo —no un reintento del anterior—, confirmá para crearlo de todos modos."
          confirmLabel="Forzar reembolso"
          trigger={
            <Button variant="secondary" className="w-full" loading={request.isPending} disabled={!valid}>
              ¿Es un reembolso distinto? Forzar de todos modos
            </Button>
          }
          onVerified={() => submit(true)}
        />
      ) : null}
    </div>
  );
}

/**
 * "Nuevo reembolso" (frame HZ8uz · toolbar): busca el cobro reembolsable de un viaje y crea la solicitud PENDING.
 * NO desembolsa — el desembolso ocurre al APROBAR en la cola. El trigger lo pasa el llamador (gateado por
 * finance:refund en la página). Al crear con éxito, cierra el modal y resetea la búsqueda.
 */
export function NewRefundDialog() {
  const [open, setOpen] = useState(false);
  const [tripInput, setTripInput] = useState('');
  const [tripId, setTripId] = useState('');
  const paymentQuery = usePaymentByTrip(tripId || null);

  function reset() {
    setTripInput('');
    setTripId('');
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="primary">
          <Plus className="size-4" aria-hidden />
          Nuevo reembolso
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo reembolso</DialogTitle>
          <DialogDescription>
            Buscá el viaje, revisá el cobro reembolsable y creá la solicitud. Entra a la cola de
            aprobación; recién al aprobar se desembolsa.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setTripId(tripInput.trim());
          }}
          className="relative"
        >
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle"
            aria-hidden
          />
          <input
            value={tripInput}
            onChange={(e) => setTripInput(e.target.value)}
            placeholder="Buscar viaje por ID (trip_…)"
            aria-label="Buscar viaje por ID"
            className="w-full rounded-md border border-border bg-surface py-2 pl-9 pr-3 text-sm text-ink placeholder:text-ink-subtle focus:border-brand focus:outline-none"
          />
        </form>

        <div className="mt-4">
          {!tripId ? (
            <EmptyState
              icon={<Undo2 className="size-6" aria-hidden />}
              title="Buscá un viaje"
              description="Ingresá el ID del viaje para ver su cobro reembolsable."
            />
          ) : paymentQuery.isLoading ? (
            <Skeleton className="h-56" />
          ) : paymentQuery.isError ? (
            <ErrorState
              title="Sin cobro reembolsable"
              description="No hay un cobro reembolsable para este viaje (no capturó, ya se reembolsó del todo, o el ID no existe)."
              onRetry={() => void paymentQuery.refetch()}
            />
          ) : paymentQuery.data ? (
            <RequestForm
              payment={paymentQuery.data}
              onDone={() => {
                setOpen(false);
                reset();
              }}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
