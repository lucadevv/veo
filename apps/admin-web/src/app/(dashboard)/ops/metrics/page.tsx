'use client';

import { useState } from 'react';
import { Landmark, TrendingUp, Coins, Undo2, Lock } from 'lucide-react';
import { useRevenueMetrics } from '@/lib/api/queries';
import type { RevenueRangeValue } from '@/lib/api/schemas';
import { money } from '@/lib/formatters';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/layout/page-header';
import { StatCard, StatCardGrid } from '@/components/ui/stat-card';
import { RevenueChart } from '@/components/charts/revenue-chart';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';

const RANGES: { value: RevenueRangeValue; label: string }[] = [
  { value: 'today', label: 'Hoy' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

/** Toggle segmentado del rango (Hoy/7d/30d) — cada cambio re-consulta el backend con ese rango. */
function RangeToggle({
  value,
  onChange,
}: {
  value: RevenueRangeValue;
  onChange: (range: RevenueRangeValue) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-surface p-1">
      {RANGES.map((r) => (
        <button
          key={r.value}
          type="button"
          onClick={() => onChange(r.value)}
          aria-pressed={value === r.value}
          className={cn(
            'rounded px-3 py-1 text-xs font-medium transition-colors',
            value === r.value ? 'bg-surface-2 text-ink' : 'text-ink-subtle hover:text-ink-muted',
          )}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Métricas · el dashboard de INGRESOS de la plataforma (revenue). Fusiona lo que antes era "Ingresos": los 4 KPIs
 * financieros del período (money-in al banco, margen, comisión bruta, reembolsado) + la recaudación por bucket.
 * Todo dato REAL de `GET /analytics/revenue?range` (payment-service agrega en TZ Lima) — nada hardcodeado, con
 * degradación honesta (loading/error/empty). El rango (Hoy/7d/30d) re-consulta y cachea por separado.
 */
export default function MetricsPage() {
  const [range, setRange] = useState<RevenueRangeValue>('today');
  const user = useSession();
  const revenue = useRevenueMetrics(range);

  if (!can(user, 'ops:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Métricas"
          description="Ingresos de la plataforma por período · money-in, comisión, margen y reembolsos."
        />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol correspondiente para ver las métricas de ingresos."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Métricas"
        description="Ingresos de la plataforma por período · money-in, comisión, margen y reembolsos."
        actions={<RangeToggle value={range} onChange={setRange} />}
      />

      <div className="flex-1 overflow-y-auto p-4 lg:p-6">
        {revenue.isLoading ? (
          <div className="space-y-5">
            <StatCardGrid>
              {['money-in', 'margin', 'commission', 'refunds'].map((k) => (
                <Skeleton key={k} className="h-24" />
              ))}
            </StatCardGrid>
            <Skeleton className="h-72" />
          </div>
        ) : revenue.isError ? (
          <ErrorState onRetry={() => void revenue.refetch()} />
        ) : revenue.data ? (
          <div className="space-y-5">
            <StatCardGrid>
              <StatCard
                icon={Landmark}
                label="Money-in al banco"
                value={money(revenue.data.moneyInCents)}
                hint="cobros digitales liquidados"
              />
              <StatCard
                icon={TrendingUp}
                label="Margen plataforma"
                value={money(revenue.data.platformMarginCents)}
                hint="comisión neta de reembolsos"
                hintTone="success"
              />
              <StatCard
                icon={Coins}
                label="Comisión bruta"
                value={money(revenue.data.grossCommissionCents)}
                hint="sobre cobros digitales"
              />
              <StatCard
                icon={Undo2}
                label="Reembolsado"
                value={money(revenue.data.refundedCents)}
                hint={
                  revenue.data.moneyInCents > 0
                    ? `${((revenue.data.refundedCents / revenue.data.moneyInCents) * 100).toFixed(1)}% de cobros`
                    : undefined
                }
                hintTone="warn"
              />
            </StatCardGrid>

            <RevenueChart series={revenue.data.series} range={range} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
