'use client';

import Link from 'next/link';
import { ArrowLeft, Archive } from 'lucide-react';
import { ApiError } from '@veo/api-client';
import { usePayoutDetail, usePayoutTrips } from '@/lib/api/queries';
import type { PayoutDetailView as PayoutDetail, PayoutTripView } from '@/lib/api/schemas';
import { money, dateTime } from '@/lib/formatters';
import { StatusPill } from '@/components/ui/status-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ReleaseHeldPayoutButton, RetryPayoutButton } from '@/components/finance/payout-actions';

/**
 * Página-detalle RICA de una liquidación (frame veo.pen `t5eZt`). Reemplaza al modal de auditoría: un full-page
 * con topbar (back + breadcrumb + estado), card protagonista "Neto a pagar" con su breakdown, "Viajes incluidos"
 * (reconstrucción por período · GET /finance/payouts/:id/trips), "Pago" (con las acciones gateadas de release/retry)
 * y "Historial" (timeline derivado de createdAt/processedAt/estado — NO hay tabla de eventos por-payout).
 * Dinero SIEMPRE Int céntimos del contrato → `money()` es el único formateador a S/.
 */
export function PayoutDetailView({ payoutId }: { payoutId: string }) {
  const detail = usePayoutDetail(payoutId);
  const trips = usePayoutTrips(payoutId);
  const short = payoutId.slice(0, 8);
  const payout = detail.data;

  return (
    <div className="flex h-full flex-col">
      <Topbar short={short} payout={payout} />

      {detail.isLoading ? (
        <div className="grid flex-1 gap-5 overflow-y-auto p-7 lg:grid-cols-[1fr_340px] lg:items-start">
          <div className="flex flex-col gap-[18px]">
            <Skeleton className="h-[340px] rounded-[20px]" />
            <Skeleton className="h-[420px] rounded-[20px]" />
          </div>
          <div className="flex flex-col gap-[18px]">
            <Skeleton className="h-[220px] rounded-[20px]" />
            <Skeleton className="h-[220px] rounded-[20px]" />
          </div>
        </div>
      ) : detail.isError || !payout ? (
        detail.error instanceof ApiError && detail.error.status === 404 ? (
          <EmptyState
            className="m-7"
            icon={<Archive className="size-6" aria-hidden />}
            title="Liquidación no disponible"
            description="Este payout ya no está en el sistema. Si lo viste en el listado, puede tardar unos minutos en desaparecer."
          />
        ) : (
          <ErrorState onRetry={() => void detail.refetch()} className="m-7" />
        )
      ) : (
        <div className="stagger grid flex-1 gap-5 overflow-y-auto p-7 lg:grid-cols-[1fr_340px] lg:items-start">
          {/* Columna izquierda: Neto a pagar + Viajes incluidos */}
          <div className="flex flex-col gap-[18px]">
            <NetCard payout={payout} tripCount={trips.data?.totalCount ?? null} />
            <TripsCard query={trips} />
          </div>
          {/* Columna derecha: Pago + Historial */}
          <div className="flex flex-col gap-[18px]">
            <PaymentCard payout={payout} />
            <HistoryCard payout={payout} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Topbar: back (→ /finance) + breadcrumb + título (Liquidación · conductor) + estado ── */
function Topbar({ short, payout }: { short: string; payout: PayoutDetail | undefined }) {
  const who = payout ? (payout.driverName ?? payout.driverId.slice(0, 8)) : null;
  return (
    <header className="sticky top-0 z-sticky flex items-center justify-between gap-4 border-b border-[color:var(--divider)] bg-surface px-7 py-4">
      <div className="flex items-center gap-3.5">
        <Link
          href="/finance"
          aria-label="Volver a Liquidaciones"
          className="grid size-[38px] shrink-0 place-items-center rounded-[10px] border border-border bg-bg text-ink-muted transition-colors hover:bg-surface-2"
        >
          <ArrowLeft className="size-[17px]" aria-hidden />
        </Link>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-1.5 text-xs text-ink-subtle">
            <Link href="/finance" className="transition-colors hover:text-ink-muted">
              Finanzas
            </Link>
            <span>/</span>
            <Link href="/finance" className="transition-colors hover:text-ink-muted">
              Liquidaciones
            </Link>
            <span>/</span>
            <span className="font-mono text-ink-muted">#{short}</span>
          </div>
          <h1 className="truncate font-display text-[21px] font-semibold tracking-[-0.4px] text-ink">
            Liquidación{who ? ` · ${who}` : ''}
          </h1>
        </div>
      </div>
      {payout ? <StatusPill status={payout.status} /> : null}
    </header>
  );
}

/* ── Card estándar del detalle (fiel: surface, radius 20, padding 22, título Space Grotesk 16/700) ── */
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-[20px] border border-black/[0.05] bg-surface p-[22px] shadow-3">
      <h2 className="font-display text-base font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

/* ── NETO A PAGAR: número protagonista + breakdown (bruto / comisión % derivado / bono / deuda CASH / neto) ── */
function NetCard({ payout, tripCount }: { payout: PayoutDetail; tripCount: number | null }) {
  // El % de comisión NO se persiste → se DERIVA del bruto (round). Sin bruto no hay porcentaje (evita /0).
  const pct = payout.grossCents > 0 ? Math.round((payout.commissionCents / payout.grossCents) * 100) : null;
  const grossSub = tripCount != null ? ` · ${tripCount} ${tripCount === 1 ? 'viaje' : 'viajes'}` : '';

  return (
    <section className="flex flex-col gap-4 rounded-[20px] border border-black/[0.05] bg-surface p-[22px] shadow-3">
      <div className="flex flex-col">
        <p className="font-display text-[11px] font-semibold uppercase tracking-[1px] text-ink-subtle">Neto a pagar</p>
        <p className="font-display text-[40px] font-bold leading-[1.1] tracking-[-1px] text-ink tabular">
          {money(payout.amountCents)}
        </p>
        <div className="mt-1 flex flex-col">
          <BreakdownRow label={`Bruto${grossSub}`} value={money(payout.grossCents)} />
          <BreakdownRow
            label={`Comisión VEO${pct != null ? ` (${pct}%)` : ''}`}
            value={`− ${money(payout.commissionCents)}`}
            tone="danger"
          />
          {payout.bonusCents > 0 ? (
            <BreakdownRow
              label="Bono por desempeño"
              value={`+ ${money(payout.bonusCents)}`}
              tone="success"
            />
          ) : null}
          {payout.debtAppliedCents > 0 ? (
            <BreakdownRow
              label="Deuda CASH deducida"
              value={`− ${money(payout.debtAppliedCents)}`}
              tone="danger"
            />
          ) : null}
          <div className="flex items-center justify-between pt-3.5">
            <span className="text-[15px] font-bold text-ink">Neto</span>
            <span className="font-mono text-base font-bold text-ink tabular">
              {money(payout.amountCents)}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Fila del breakdown: label (Outfit, muted) · monto (mono). `tone` colorea aportes/deducciones. Divider inferior. */
function BreakdownRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'danger' | 'success';
}) {
  const valueColor = tone === 'danger' ? 'text-danger' : tone === 'success' ? 'text-success' : 'text-ink';
  return (
    <div className="flex items-center justify-between border-b border-divider py-3">
      <span className="text-sm text-ink-muted">{label}</span>
      <span className={`font-mono text-sm font-semibold tabular ${valueColor}`}>{value}</span>
    </div>
  );
}

/* ── Viajes incluidos: lista reconstruida por período (cap 50) + "+N más". Estados loading/empty/error ── */
function TripsCard({ query }: { query: ReturnType<typeof usePayoutTrips> }) {
  const result = query.data;
  const remaining = result ? result.totalCount - result.trips.length : 0;

  return (
    <Card title="Viajes incluidos">
      {query.isLoading ? (
        <div className="flex flex-col" role="status" aria-label="Cargando viajes">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3.5 border-b border-divider py-3 last:border-b-0">
              <Skeleton className="h-4 w-[90px]" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState onRetry={() => void query.refetch()} />
      ) : !result || result.trips.length === 0 ? (
        <p className="py-2 text-sm text-ink-muted">Sin viajes en el período.</p>
      ) : (
        <>
          <div className="flex flex-col">
            {result.trips.map((trip, i) => (
              <TripRow key={trip.tripId} trip={trip} last={i === result.trips.length - 1} />
            ))}
          </div>
          {remaining > 0 ? (
            <p className="text-[13px] font-medium text-accent">
              + {remaining} {remaining === 1 ? 'viaje más' : 'viajes más'}
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

/**
 * Fila de viaje: id corto (mono) · cuándo + riel · monto BRUTO. Honesto: el contrato NO trae ruta (origen→destino),
 * solo tripId/amount/capturedAt/method → mostramos lo que hay, sin inventar una ruta.
 */
function TripRow({ trip, last }: { trip: PayoutTripView; last: boolean }) {
  return (
    <div
      className={`flex items-center gap-3.5 py-3 ${last ? '' : 'border-b border-divider'}`}
    >
      <span className="w-[90px] shrink-0 font-mono text-[13px] font-medium text-ink">
        #{trip.tripId.slice(0, 8)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-[13px] text-ink">{dateTime(trip.capturedAt)}</span>
        <span className="truncate text-xs text-ink-subtle">
          Cobro{trip.method ? ` · ${trip.method}` : ''}
        </span>
      </div>
      <span className="shrink-0 font-mono text-sm font-semibold text-ink tabular">
        {money(trip.amountCents)}
      </span>
    </div>
  );
}

/* ── Pago: método (Yape FIJO), período legible + acciones gateadas. "Cuenta"/"Programado" omitidas (sin seam) ── */
function PaymentCard({ payout }: { payout: PayoutDetail }) {
  return (
    <Card title="Pago">
      <div className="flex flex-col gap-[11px]">
        {/* Yape FIJO: DEFAULT_PAYOUT_METHOD='YAPE' está hardcodeado en payment-service; el riel no se persiste. */}
        <InfoRow label="Método" value="Yape" />
        <InfoRow label="Periodo" value={formatPeriod(payout.period)} />
      </div>
      {/* Acciones REALES y gateadas (finance:payout + step-up MFA), reusadas de payout-actions: release solo en
          HELD, retry solo en FAILED. No hay acción de "retener" manual (HELD nace de driver.flagged) → se omite. */}
      {payout.status === 'HELD' ? (
        <div className="[&_button]:h-11 [&_button]:w-full">
          <ReleaseHeldPayoutButton driverId={payout.driverId} amountCents={payout.amountCents} />
        </div>
      ) : payout.status === 'FAILED' ? (
        <div className="[&_button]:h-11 [&_button]:w-full">
          <RetryPayoutButton payoutId={payout.id} amountCents={payout.amountCents} />
        </div>
      ) : null}
    </Card>
  );
}

/** Fila etiqueta ▸ valor del panel de pago (Outfit 13; valor semibold). */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[13px] text-ink-muted">{label}</span>
      <span className="text-[13px] font-semibold text-ink">{value}</span>
    </div>
  );
}

/* ── Historial: timeline DERIVADO (no hay tabla payout_events) de createdAt → processedAt / estado actual ── */
function HistoryCard({ payout }: { payout: PayoutDetail }) {
  const steps = buildTimeline(payout);
  return (
    <Card title="Historial">
      <ol className="flex flex-col">
        {steps.map((step, i) => {
          const last = i === steps.length - 1;
          return (
            <li key={step.label} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span
                  className={
                    step.pending
                      ? 'mt-0.5 size-[11px] rounded-full border-2 border-warn bg-surface'
                      : 'mt-0.5 size-[11px] rounded-full border-2 border-accent bg-accent'
                  }
                  aria-hidden
                />
                {!last ? <span className="w-0.5 flex-1 bg-divider" aria-hidden /> : null}
              </div>
              <div className={`flex flex-1 flex-col gap-px ${last ? '' : 'pb-[18px]'}`}>
                <span className="text-[13px] font-medium text-ink">{step.label}</span>
                <span className="text-xs text-ink-subtle tabular">{step.at}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

interface TimelineStep {
  label: string;
  at: string;
  pending?: boolean;
}

/**
 * Hitos REALES del payout (no hay tabla de eventos por-payout): "Liquidación generada" (createdAt) y, según el
 * estado, "Procesado" (processedAt) o el estado en curso. Honesto: es un timeline DERIVADO, no una traza granular.
 */
function buildTimeline(payout: PayoutDetail): TimelineStep[] {
  const steps: TimelineStep[] = [
    { label: 'Liquidación generada', at: dateTime(payout.createdAt) },
  ];
  if (payout.processedAt) {
    steps.push({ label: 'Desembolso confirmado', at: dateTime(payout.processedAt) });
    return steps;
  }
  switch (payout.status) {
    case 'PROCESSING':
      steps.push({ label: 'Desembolso en camino', at: 'ahora', pending: true });
      break;
    case 'HELD':
      steps.push({
        label: payout.heldReason ? `Retenido · ${payout.heldReason}` : 'Retenido',
        at: 'en revisión',
        pending: true,
      });
      break;
    case 'FAILED':
      steps.push({ label: 'Rechazado por el riel', at: 'requiere reintento', pending: true });
      break;
    default:
      steps.push({ label: 'En cola de pago', at: 'a la espera del run', pending: true });
  }
  return steps;
}

/**
 * Período legible. El backend lo entrega como rango ISO ("<startISO>..<endISO>") — se formatea a "d mmm – d mmm yyyy".
 * Si no matchea el patrón (formato desconocido), se muestra verbatim (honesto, nunca inventa el rango).
 */
function formatPeriod(period: string): string {
  const [startRaw, endRaw, ...rest] = period.split('..');
  if (!startRaw || !endRaw || rest.length > 0) return period;
  const start = new Date(startRaw);
  const end = new Date(endRaw);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return period;
  const dm = new Intl.DateTimeFormat('es-PE', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const dmy = new Intl.DateTimeFormat('es-PE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${dm.format(start)} – ${dmy.format(end)}`;
}
