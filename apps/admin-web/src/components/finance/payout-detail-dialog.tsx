'use client';

import { usePayoutDetail } from '@/lib/api/queries';
import type { PayoutDetailView } from '@/lib/api/schemas';
import { money, dateTime } from '@/lib/formatters';
import { StatusPill } from '@/components/ui/status-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * Detalle de auditoría de una liquidación (GET /finance/payouts/:id vía `usePayoutDetail`). La lista de
 * Liquidaciones no trae el breakdown de la deuda CASH ni la traza del desembolso: este sheet abre el NETO
 * en sus componentes (deuda saldada − crédito devuelto = deuda aplicada) y suma dedupKey/externalRef/createdAt.
 * Se abre al clickear una fila; `payoutId === null` lo mantiene cerrado (y desactiva el hook).
 * Dinero SIEMPRE Int céntimos del contrato → `money()` es el único punto que formatea a S/.
 */
export function PayoutDetailDialog({
  payoutId,
  onClose,
}: {
  payoutId: string | null;
  onClose: () => void;
}) {
  const query = usePayoutDetail(payoutId);

  return (
    <Dialog open={payoutId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Detalle de liquidación</DialogTitle>
        </DialogHeader>
        {query.isLoading ? (
          <DetailSkeleton />
        ) : query.isError || !query.data ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : (
          <DetailBody payout={query.data} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Fila etiqueta ▸ valor. `mono` para IDs/refs; el valor cae a "—" cuando el caller pasa null. */
function Row({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/40 py-2.5 last:border-b-0">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd
        className={
          mono
            ? 'text-right font-mono text-xs text-ink-muted'
            : 'text-right text-sm font-medium text-ink'
        }
      >
        {children}
      </dd>
    </div>
  );
}

function DetailBody({ payout }: { payout: PayoutDetailView }) {
  return (
    <dl>
      <Row label="Conductor">{payout.driverName ?? payout.driverId}</Row>
      <Row label="Estado">
        <StatusPill status={payout.status} />
      </Row>
      <Row label="Monto (neto)">
        <span className="tabular">{money(payout.amountCents)}</span>
      </Row>
      <Row label="Deuda saldada">
        <span className="tabular">{money(payout.debtSettledCents)}</span>
      </Row>
      <Row label="Crédito devuelto">
        <span className="tabular">{money(payout.creditBackCents)}</span>
      </Row>
      <Row label="Deuda aplicada">
        <span className="tabular">{money(payout.debtAppliedCents)}</span>
      </Row>
      <Row label="Dedup key" mono>
        {payout.dedupKey ?? '—'}
      </Row>
      <Row label="Ref externa" mono>
        {payout.externalRef ?? '—'}
      </Row>
      <Row label="Creado">{dateTime(payout.createdAt)}</Row>
    </dl>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="Cargando detalle">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}
