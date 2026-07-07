'use client';

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import type { RevenueSeriesPoint, RevenueRangeValue } from '@/lib/api/schemas';
import { money, time, date } from '@/lib/formatters';
import { EmptyState } from '@/components/ui/states';
import { useTokenColors } from './use-token-colors';

const CHART_TITLE: Record<RevenueRangeValue, string> = {
  today: 'Recaudación por hora · últimas 24h',
  '7d': 'Recaudación por día · últimos 7 días',
  '30d': 'Recaudación por día · últimos 30 días',
};

interface RevenueChartProps {
  series: RevenueSeriesPoint[];
  range: RevenueRangeValue;
}

/**
 * Recaudación (neto al banco de cobros digitales) por bucket — hora si `today`, día si `7d`/`30d`. La barra pico
 * va resaltada + una pill muestra su valor. La Σ de la serie == `moneyInCents` del período (reconcilia con el KPI).
 * Colores de tokens (sin hardcode) y degradación honesta: sin datos → EmptyState, no una gráfica vacía.
 */
export function RevenueChart({ series, range }: RevenueChartProps) {
  const c = useTokenColors();

  const peakCents = series.reduce((max, p) => Math.max(max, p.revenueCents), 0);
  const data = series.map((p) => ({
    bucket: p.bucket,
    label: range === 'today' ? time(p.bucket) : date(p.bucket),
    revenue: p.revenueCents / 100,
    peak: peakCents > 0 && p.revenueCents === peakCents,
  }));

  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-semibold text-ink">{CHART_TITLE[range]}</p>
          <p className="text-xs text-ink-subtle">Neto al banco (cobros digitales) por bucket.</p>
        </div>
        {peakCents > 0 ? (
          <div className="flex items-baseline gap-1.5 rounded-full bg-brand/12 px-3 py-1">
            <span className="tabular text-sm font-semibold text-brand">{money(peakCents)}</span>
            <span className="text-xs text-ink-subtle">pico</span>
          </div>
        ) : null}
      </div>

      {series.length === 0 ? (
        <EmptyState
          className="mt-4"
          title="Sin datos del periodo"
          description="No hay recaudación digital para graficar en este rango."
        />
      ) : (
        <div className="mt-4 h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
              <XAxis
                dataKey="label"
                stroke={c.inkMuted}
                fontSize={11}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <Tooltip
                cursor={{ fill: 'var(--surface-2)' }}
                contentStyle={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  fontSize: 12,
                  color: 'var(--ink)',
                }}
                formatter={(value: number) => [money(Math.round(value * 100)), 'Recaudación']}
              />
              <Bar dataKey="revenue" radius={[3, 3, 0, 0]}>
                {data.map((d) => (
                  <Cell key={d.bucket} fill={c.brand} fillOpacity={d.peak ? 1 : 0.35} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
