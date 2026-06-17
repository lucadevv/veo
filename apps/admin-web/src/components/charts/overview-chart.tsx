'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { OverviewSeriesPoint } from '@/lib/api/schemas';
import { money, time } from '@/lib/formatters';
import { EmptyState } from '@/components/ui/states';
import { useTokenColors } from './use-token-colors';

interface OverviewChartProps {
  series: OverviewSeriesPoint[];
}

interface ChartDatum {
  label: string;
  trips: number;
  revenue: number;
}

/** Gráficas del overview: viajes y recaudación por intervalo. Colores accesibles de tokens. */
export function OverviewChart({ series }: OverviewChartProps) {
  const c = useTokenColors();

  if (series.length === 0) {
    return (
      <EmptyState title="Sin datos del periodo" description="No hay actividad para graficar." />
    );
  }

  const data: ChartDatum[] = series.map((p) => ({
    label: time(p.bucket),
    trips: p.trips,
    revenue: p.revenueCents / 100,
  }));

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div>
        <p className="mb-3 text-sm font-medium text-ink">Viajes por intervalo</p>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="trips-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={c.accent} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={c.accent} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={c.border} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" stroke={c.inkMuted} fontSize={12} tickLine={false} />
              <YAxis stroke={c.inkMuted} fontSize={12} tickLine={false} allowDecimals={false} />
              <Tooltip
                contentStyle={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  fontSize: 12,
                  color: 'var(--ink)',
                }}
                formatter={(value: number) => [String(value), 'Viajes']}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area
                type="monotone"
                dataKey="trips"
                name="Viajes"
                stroke={c.accent}
                strokeWidth={2}
                fill="url(#trips-fill)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div>
        <p className="mb-3 text-sm font-medium text-ink">Recaudación por intervalo</p>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid stroke={c.border} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" stroke={c.inkMuted} fontSize={12} tickLine={false} />
              <YAxis stroke={c.inkMuted} fontSize={12} tickLine={false} width={64} />
              <Tooltip
                contentStyle={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  fontSize: 12,
                  color: 'var(--ink)',
                }}
                formatter={(value: number) => [money(Math.round(value * 100)), 'Recaudación']}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="revenue" name="Recaudación (S/)" fill={c.brand} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
