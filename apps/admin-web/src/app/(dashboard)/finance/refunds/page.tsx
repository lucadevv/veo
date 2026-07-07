'use client';

import { useRef, useState } from 'react';
import { Lock, Search, Undo2, User, Car, CreditCard } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { solesToCents } from '@veo/utils/money';
import { usePaymentByTrip, useRefund, qk } from '@/lib/api/queries';
import type { RefundablePaymentView } from '@/lib/api/schemas';
import { money } from '@/lib/formatters';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { StepUpDialog } from '@/components/security/step-up-dialog';

const REASON_MIN_LENGTH = 3;

// Etiquetas de presentación por enum del contrato (método + estado del cobro). Mapa por clave tipada, no
// comparación de strings sueltos.
const METHOD_LABEL: Record<RefundablePaymentView['method'], string> = {
  YAPE: 'Yape',
  PLIN: 'Plin',
  CASH: 'Efectivo',
  CARD: 'Tarjeta',
  PAGOEFECTIVO: 'PagoEfectivo',
};
const STATUS_LABEL: Record<RefundablePaymentView['status'], string> = {
  PENDING: 'Pendiente',
  CAPTURED: 'Capturado',
  FAILED: 'Fallido',
  REFUNDED: 'Reembolsado',
  PARTIALLY_REFUNDED: 'Parcialmente reembolsado',
  DEBT: 'En deuda',
};

// ── Idempotencia del money-OUT (mismo patrón que RefundDialog): nonce ligado a (tripId, céntimos) en
// sessionStorage, sobrevive remonte/refresh hasta el ÉXITO. Tolerante a storage caído (nunca bloquea el
// reembolso). Ver refund-dialog.tsx para el detalle del porqué. ──
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

/** Fila etiqueta→valor de la card del pago. */
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-ink-muted">{label}</span>
      <span className="text-right text-ink">{children}</span>
    </div>
  );
}

/** Card izquierda: el cobro reembolsable del viaje (GET /finance/payments/by-trip/:tripId). */
function PaymentCard({ payment }: { payment: RefundablePaymentView }) {
  return (
    <div className="space-y-1 rounded-lg border border-border bg-surface p-5">
      <div className="mb-2 flex items-center gap-2">
        <CreditCard className="size-4 text-brand" aria-hidden />
        <h2 className="text-sm font-semibold text-ink">Pago del viaje</h2>
      </div>
      <InfoRow label="Viaje">
        <span className="font-mono text-xs">{payment.tripId.slice(0, 12)}…</span>
      </InfoRow>
      <InfoRow label="Método">{METHOD_LABEL[payment.method]}</InfoRow>
      <InfoRow label="Estado">
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium',
            payment.status === 'CAPTURED' ? 'bg-success/12 text-success' : 'bg-warn/12 text-warn',
          )}
        >
          {STATUS_LABEL[payment.status]}
        </span>
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
      <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
        <span className="text-sm font-medium text-ink-muted">Reembolsable</span>
        <span className="tabular text-2xl font-semibold text-ink">
          {money(payment.refundableCents)}
        </span>
      </div>
      {payment.refundedCents > 0 ? (
        <p className="text-xs text-ink-subtle">Ya reembolsado: {money(payment.refundedCents)}</p>
      ) : null}
    </div>
  );
}

/** Card derecha: el formulario de reembolso (Total/Parcial + monto + motivo + MFA). */
function RefundForm({ payment }: { payment: RefundablePaymentView }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const refund = useRefund();
  const [mode, setMode] = useState<'TOTAL' | 'PARCIAL'>('TOTAL');
  const [soles, setSoles] = useState('');
  const [reason, setReason] = useState('');
  const [forceNew, setForceNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  async function submit() {
    setError(null);
    if (forceNew) {
      clearNonce(attemptSlot(payment.tripId, amountCents));
      attemptRef.current = null;
    }
    try {
      await refund.mutateAsync({
        tripId: payment.tripId,
        amountCents,
        reason: reason.trim(),
        idempotencyKey: operationKey(amountCents),
        forceNew,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo emitir el reembolso.');
      return;
    }
    clearNonce(attemptSlot(payment.tripId, amountCents));
    attemptRef.current = null;
    toast({ tone: 'success', title: 'Reembolso emitido' });
    setSoles('');
    setReason('');
    setForceNew(false);
    setMode('TOTAL');
    // Refresca el cobro reembolsable (el saldo cambió).
    void qc.invalidateQueries({ queryKey: qk.paymentByTrip(payment.tripId) });
  }

  return (
    <div className="space-y-4 rounded-lg border border-border bg-surface p-5">
      <div className="flex items-center gap-2">
        <Undo2 className="size-4 text-brand" aria-hidden />
        <h2 className="text-sm font-semibold text-ink">Reembolsar</h2>
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
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="Detalle visible para el pasajero…"
          className="w-full resize-none rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-subtle focus:border-brand focus:outline-none"
        />
      </Field>

      <label htmlFor="refund-force-new" className="flex items-start gap-2.5 text-sm">
        <input
          id="refund-force-new"
          type="checkbox"
          checked={forceNew}
          onChange={(e) => setForceNew(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 rounded border-border accent-accent"
        />
        <span className="text-ink-muted">
          Es un reembolso nuevo, no un reintento (habilita un 2º parcial idéntico a propósito).
        </span>
      </label>

      <StepUpDialog
        title="Emitir reembolso"
        description="Acción money-OUT: confirmá con tu código TOTP (step-up MFA). El admin-bff lo exige server-side."
        trigger={
          <Button variant="primary" className="w-full" loading={refund.isPending} disabled={!valid}>
            Reembolsar {money(amountCents)}
          </Button>
        }
        onVerified={submit}
      />
    </div>
  );
}

export default function RefundsPage() {
  const user = useSession();
  const [tripInput, setTripInput] = useState('');
  const [tripId, setTripId] = useState('');
  const paymentQuery = usePaymentByTrip(tripId || null);

  if (!can(user, 'finance:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Reembolsos"
          breadcrumbs={[{ label: 'Finanzas' }, { label: 'Reembolsos' }]}
        />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol FINANCE o ADMIN para ver los reembolsos."
        />
      </div>
    );
  }

  const canRefund = can(user, 'finance:refund');

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Reembolsos"
        description="Buscá el viaje, revisá el cobro reembolsable y reembolsá total o parcial. Cada reembolso pide step-up MFA y queda auditado."
        breadcrumbs={[{ label: 'Finanzas' }, { label: 'Reembolsos' }]}
      />
      <div className="min-h-0 flex-1 space-y-5 overflow-auto px-4 pb-6 pt-4 lg:px-6">
        {/* Búsqueda por trip (dispara el lookup solo al confirmar, no por tecla). */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setTripId(tripInput.trim());
          }}
          className="relative max-w-xl"
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

        {!tripId ? (
          <EmptyState
            icon={<Search className="size-6" aria-hidden />}
            title="Buscá un viaje"
            description="Ingresá el ID del viaje para ver su cobro reembolsable y emitir el reembolso."
          />
        ) : paymentQuery.isLoading ? (
          <div className="grid gap-5 lg:grid-cols-2">
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
          </div>
        ) : paymentQuery.isError ? (
          <ErrorState
            title="Sin cobro reembolsable"
            description="No hay un cobro reembolsable para este viaje (no capturó, ya se reembolsó del todo, o el ID no existe)."
            onRetry={() => void paymentQuery.refetch()}
          />
        ) : paymentQuery.data ? (
          <div className="grid gap-5 lg:grid-cols-2">
            <PaymentCard payment={paymentQuery.data} />
            {canRefund ? (
              <RefundForm payment={paymentQuery.data} />
            ) : (
              <EmptyState
                icon={<Lock className="size-6" aria-hidden />}
                title="Sin permiso para reembolsar"
                description="Necesitás finance:refund para emitir reembolsos."
              />
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
