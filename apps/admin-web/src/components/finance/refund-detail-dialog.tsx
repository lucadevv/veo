'use client';

import { useRefundDetail } from '@/lib/api/queries';
import type { RefundDetailView } from '@/lib/api/schemas';
import { money, dateTime, relativeAccess } from '@/lib/formatters';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RefundStatusPill } from '@/components/finance/refund-status-pill';
import { RefundMethodCell } from '@/components/finance/refund-method';
import { ApproveRefundButton, RejectRefundButton } from '@/components/finance/refund-actions';

/**
 * Detalle de un reembolso (GET /finance/refunds/:id vía `useRefundDetail`). La cola no trae el saldo del cobro
 * ni el motivo de rechazo/ref externa: este sheet los abre y, si el reembolso sigue PENDING, ofrece aprobar/
 * rechazar (money-OUT con step-up MFA) sin salir del contexto. Se abre al clickear una fila; `refundId === null`
 * lo mantiene cerrado (y desactiva el hook). Dinero SIEMPRE Int céntimos → `money()` formatea a S/.
 */
export function RefundDetailDialog({
  refundId,
  onClose,
}: {
  refundId: string | null;
  onClose: () => void;
}) {
  const query = useRefundDetail(refundId);

  return (
    <Dialog open={refundId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Detalle del reembolso</DialogTitle>
          <DialogDescription>
            La solicitud, el saldo del cobro ligado y la traza del desembolso.
          </DialogDescription>
        </DialogHeader>
        {query.isLoading ? (
          <DetailSkeleton />
        ) : query.isError || !query.data ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : (
          <DetailBody refund={query.data} />
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

function DetailBody({ refund }: { refund: RefundDetailView }) {
  return (
    <>
      <dl>
        <Row label="Pasajero">{refund.passengerName ?? refund.passengerId ?? '—'}</Row>
        <Row label="Viaje" mono>
          {refund.tripId}
        </Row>
        <Row label="Estado">
          <RefundStatusPill status={refund.status} />
        </Row>
        <Row label="Monto">
          <span className="tabular">{money(refund.amountCents)}</span>
        </Row>
        <Row label="Método">
          <RefundMethodCell method={refund.method} />
        </Row>
        <Row label="Motivo">{refund.reason}</Row>
        <Row label="Reembolsable del cobro">
          <span className="tabular">{money(refund.refundableCents)}</span>
        </Row>
        <Row label="Ya reembolsado">
          <span className="tabular">{money(refund.paymentRefundedCents)}</span>
        </Row>
        <Row label="Solicitado">{relativeAccess(refund.requestedAt)}</Row>
        <Row label="Solicitado por" mono>
          {refund.requestedBy}
        </Row>
        {refund.approvedBy ? (
          <Row label="Aprobado por" mono>
            {refund.approvedBy}
          </Row>
        ) : null}
        {refund.failureReason ? <Row label="Motivo del rechazo">{refund.failureReason}</Row> : null}
        {refund.externalRefundId ? (
          <Row label="Ref externa" mono>
            {refund.externalRefundId}
          </Row>
        ) : null}
        <Row label="Actualizado">{dateTime(refund.updatedAt)}</Row>
      </dl>

      {/* Acciones money-OUT solo mientras la solicitud sigue PENDING (los botones se auto-ocultan sin permiso). */}
      {refund.status === 'PENDING' ? (
        <div className="mt-5 flex justify-end gap-2 border-t border-border pt-4">
          <RejectRefundButton refundId={refund.id} />
          <ApproveRefundButton refundId={refund.id} amountCents={refund.amountCents} />
        </div>
      ) : null}
    </>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="Cargando detalle">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}
