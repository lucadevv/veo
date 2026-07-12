'use client';

import { useState } from 'react';
import { Download, MapPin } from 'lucide-react';
import { useRevenueMetrics } from '@/lib/api/queries';
import type { RevenueRangeValue } from '@/lib/api/schemas';
import { money } from '@/lib/formatters';
import { cn } from '@/lib/cn';
import { AdminTopbar } from '@/components/layout/admin-topbar';
import { KpiCard } from '@/components/ui/kpi-card';
import { Donut, type DonutSegment } from '@/components/charts/donut';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, PermissionState } from '@/components/ui/states';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useRequestAccess } from '@/lib/use-request-access';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';

const RANGES: { value: RevenueRangeValue; label: string }[] = [
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
];

const RANGE_SUBTITLE: Record<RevenueRangeValue, string> = {
  today: 'Rendimiento del negocio · hoy',
  '7d': 'Rendimiento del negocio · últimos 7 días',
  '30d': 'Rendimiento del negocio · últimos 30 días',
  '90d': 'Rendimiento del negocio · últimos 90 días',
};

/** Formato compacto de dinero para KPIs (S/ 1.42M · S/ 356K). Valores chicos → formato completo. */
function moneyCompact(cents: number): string {
  const soles = cents / 100;
  if (Math.abs(soles) >= 1_000_000) return `S/ ${(soles / 1_000_000).toFixed(2)}M`;
  if (Math.abs(soles) >= 10_000) return `S/ ${Math.round(soles / 1_000)}K`;
  return money(cents);
}

/** Etiqueta corta del bucket de la serie: día "YYYY-MM-DD" → "DD"; hora ISO → "HH". */
function bucketLabel(bucket: string): string {
  const day = bucket.match(/^\d{4}-\d{2}-(\d{2})$/);
  if (day) return String(Number(day[1]));
  const hour = bucket.match(/T(\d{2}):/);
  if (hour) return String(Number(hour[1]));
  return bucket.slice(-2);
}

// Modo 3-way del donut: Fijo/Puja (split del on-demand por dispatchMode) + Carpooling. ON_DEMAND queda de
// fallback para filas legacy sin dispatchMode denormalizado.
const MODE_LABEL: Record<string, string> = {
  FIXED: 'Fijo',
  PUJA: 'Puja',
  CARPOOLING: 'Carpooling',
  ON_DEMAND: 'On-demand',
};
const MODE_COLOR: Record<string, string> = {
  FIXED: '#0075A9',
  PUJA: '#F2AF48',
  CARPOOLING: '#00C853',
  ON_DEMAND: '#0075A9',
};

/**
 * Métricas · dashboard de negocio (revenue) fiel al frame IYkXv. TODO dato REAL de `GET /analytics/revenue?range`
 * (payment-service): ingresos, viajes, ticket promedio, take rate, serie por día, revenue por modo, deltas vs
 * período previo. "Top distritos" no tiene fuente (no hay geo/distrito en el backend) → estado honesto. El rango
 * (7d/30d/90d) re-consulta. Exportar baja la serie a CSV real.
 */
export default function MetricsPage() {
  const [range, setRange] = useState<RevenueRangeValue>('30d');
  const [exportOpen, setExportOpen] = useState(false);
  const user = useSession();
  const requestAccess = useRequestAccess();
  const revenue = useRevenueMetrics(range);
  const d = revenue.data;

  function onExport() {
    if (!d) return;
    const rows = [['bucket', 'revenue_cents'], ...d.series.map((p) => [p.bucket, String(p.revenueCents)])];
    const csv = rows.map((r) => r.join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `veo-ingresos-${range}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const actions = (
    <>
      <div className="flex items-center gap-0.5 rounded-[10px] border border-border bg-bg p-[3px]">
        {RANGES.map((r) => {
          const active = range === r.value;
          return (
            <button
              key={r.value}
              type="button"
              onClick={() => setRange(r.value)}
              aria-pressed={active}
              className={cn(
                'rounded-lg px-3.5 py-[7px] text-[13px] transition-colors',
                active
                  ? 'bg-surface font-semibold text-ink shadow-[0_2px_6px_-2px_rgba(15,23,42,0.1)]'
                  : 'font-medium text-ink-muted hover:text-ink',
              )}
            >
              {r.label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => setExportOpen(true)}
        disabled={!d}
        className="flex items-center gap-2 rounded-[10px] bg-accent px-[15px] py-[9px] text-[13px] font-semibold text-accent-on shadow-brand transition-colors hover:bg-accent-hover disabled:opacity-50"
      >
        <Download className="size-[15px]" aria-hidden />
        Exportar
      </button>
    </>
  );

  const topbar = <AdminTopbar title="Métricas" subtitle={RANGE_SUBTITLE[range]} actions={actions} />;

  if (!can(user, 'ops:view')) {
    return (
      <div className="flex h-full flex-col">
        {topbar}
        <PermissionState
          className="flex-1"
          section="Métricas"
          permission="ops:view"
          onRequest={() => requestAccess('ops:view')}
        />
      </div>
    );
  }

  const takeRate = d && d.moneyInCents > 0 ? (d.grossCommissionCents / d.moneyInCents) * 100 : null;
  const maxRev = d ? d.series.reduce((m, p) => Math.max(m, p.revenueCents), 0) : 0;
  const peakIdx = d
    ? d.series.reduce((best, p, i) => (p.revenueCents > (d.series[best]?.revenueCents ?? 0) ? i : best), 0)
    : 0;
  const modeSegments: DonutSegment[] = d
    ? d.byMode.map((m) => ({
        label: MODE_LABEL[m.mode] ?? m.mode,
        value: m.revenueCents,
        color: MODE_COLOR[m.mode] ?? '#B0BEC5',
      }))
    : [];

  return (
    <div className="flex h-full flex-col">
      {topbar}

      <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-7">
        {revenue.isLoading ? (
          <div className="flex flex-col gap-5">
            <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-[104px] rounded-[18px]" />
              ))}
            </div>
            <Skeleton className="h-72 rounded-xl" />
          </div>
        ) : revenue.isError ? (
          <ErrorState onRetry={() => void revenue.refetch()} />
        ) : d ? (
          <>
            {/* KPIs */}
            <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
              <KpiCard label={`Ingresos (${range})`} value={moneyCompact(d.moneyInCents)} deltaPct={d.deltas.moneyInPct} />
              <KpiCard label={`Viajes (${range})`} value={d.tripCount.toLocaleString('es-PE')} deltaPct={d.deltas.tripCountPct} />
              <KpiCard label="Ticket promedio" value={money(d.avgTicketCents)} deltaPct={d.deltas.avgTicketPct} />
              <KpiCard label="Take rate" value={takeRate != null ? `${takeRate.toFixed(1)}%` : '—'} />
            </div>

            {/* Ingresos por día */}
            <div className="flex flex-col gap-[18px] rounded-xl border border-black/[0.05] bg-surface p-6 shadow-3">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-display text-base font-bold text-ink">Ingresos por día</h2>
                  <p className="text-xs text-ink-muted">Money-in neto al banco · {range}</p>
                </div>
                {d.deltas.moneyInPct != null ? (
                  <span
                    className={cn(
                      'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold',
                      d.deltas.moneyInPct >= 0 ? 'bg-success/[0.12] text-success' : 'bg-danger/[0.08] text-danger',
                    )}
                  >
                    {d.deltas.moneyInPct >= 0 ? '+' : ''}
                    {(d.deltas.moneyInPct * 100).toFixed(1)}% vs período previo
                  </span>
                ) : null}
              </div>
              {d.series.length === 0 ? (
                <p className="py-10 text-center text-[13px] text-ink-subtle">Sin ingresos en el período.</p>
              ) : (
                <div className="flex items-end gap-2" style={{ height: 190 }}>
                  {d.series.map((p, i) => {
                    const h = maxRev > 0 ? Math.max(4, Math.round((p.revenueCents / maxRev) * 170)) : 4;
                    return (
                      <div key={p.bucket} className="flex flex-1 flex-col items-center gap-2">
                        <div className="flex w-full flex-1 items-end justify-center">
                          <div
                            className={i === peakIdx ? 'w-full bg-accent' : 'w-full bg-accent/35'}
                            style={{ height: h, borderRadius: '6px 6px 0 0', maxWidth: 24 }}
                            title={`${money(p.revenueCents)}`}
                          />
                        </div>
                        <span className="text-[11px] text-ink-subtle">{bucketLabel(p.bucket)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Ingresos por modo + Top distritos */}
            <div className="flex flex-col gap-5 xl:flex-row">
              <div className="flex flex-col gap-4 rounded-xl border border-black/[0.05] bg-surface p-6 shadow-3 xl:w-[440px]">
                <h2 className="font-display text-base font-bold text-ink">Ingresos por modo</h2>
                {modeSegments.length > 0 ? (
                  <Donut segments={modeSegments} centerValue={moneyCompact(d.moneyInCents)} centerLabel="total" />
                ) : (
                  <p className="py-8 text-center text-[13px] text-ink-subtle">Sin ingresos por modo en el período.</p>
                )}
                <p className="text-[11px] text-ink-subtle">
                  Split 3-way: Fijo/Puja (según el modo de despacho del viaje) + Carpooling.
                </p>
              </div>

              <div className="flex flex-1 flex-col gap-4 rounded-xl border border-black/[0.05] bg-surface p-6 shadow-3">
                <h2 className="font-display text-base font-bold text-ink">Top distritos por ingreso</h2>
                {d.topDistricts.length > 0 ? (
                  <ul className="flex flex-col gap-3">
                    {(() => {
                      const maxCents = Math.max(...d.topDistricts.map((x) => x.revenueCents), 1);
                      return d.topDistricts.slice(0, 8).map((row) => (
                        <li key={row.district} className="flex flex-col gap-1.5">
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="truncate text-[13px] font-medium text-ink">{row.district}</span>
                            <span className="shrink-0 font-mono text-[13px] font-semibold text-ink tabular">
                              {money(row.revenueCents)}
                            </span>
                          </div>
                          <div className="h-2 w-full overflow-hidden rounded-full bg-bg">
                            <div
                              className="h-full rounded-full bg-accent"
                              style={{ width: `${Math.round((row.revenueCents / maxCents) * 100)}%` }}
                            />
                          </div>
                        </li>
                      ));
                    })()}
                  </ul>
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center">
                    <span className="grid size-11 place-items-center rounded-full bg-bg text-ink-subtle">
                      <MapPin className="size-5" aria-hidden />
                    </span>
                    <p className="text-[13px] font-medium text-ink-muted">Sin ingresos por distrito en el período</p>
                    <p className="max-w-[280px] text-xs text-ink-subtle">
                      Aparece cuando haya viajes cobrados con origen dentro de la cobertura de distritos de Lima.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}
      </div>

      {/* Modal de exportar (fiel al frame QFcHq, con CTAs corregidos — el board traía los del modal de cancelar).
          HONESTO: la descarga es un CSV client-side INSTANTÁNEO (no hay envío por correo). Ícono en accent. */}
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="max-w-[420px] p-[30px]">
          <div className="flex flex-col items-center gap-5 text-center">
            <span className="grid size-[52px] place-items-center rounded-[14px] bg-accent/10 text-accent">
              <Download className="size-[26px]" aria-hidden />
            </span>
            <div className="flex flex-col gap-2">
              <DialogTitle className="font-display text-[22px] font-bold tracking-[-0.4px] text-ink">
                Exportar métricas
              </DialogTitle>
              <DialogDescription className="text-sm leading-relaxed text-ink-muted">
                Se descargará un CSV con los ingresos por día del período ({range}). La descarga
                empieza al confirmar.
              </DialogDescription>
            </div>
            <div className="flex w-full flex-col gap-3">
              <button
                type="button"
                onClick={() => {
                  onExport();
                  setExportOpen(false);
                }}
                className="flex w-full items-center justify-center gap-2 rounded-control bg-accent px-5 py-3.5 text-[15px] font-semibold text-accent-on shadow-brand transition-colors hover:bg-accent-hover"
              >
                <Download className="size-[18px]" aria-hidden />
                Exportar CSV
              </button>
              <button
                type="button"
                onClick={() => setExportOpen(false)}
                className="w-full rounded-control border border-border bg-surface px-5 py-3.5 text-[15px] font-semibold text-ink transition-colors hover:bg-surface-2"
              >
                Cancelar
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
