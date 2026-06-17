'use client';

import { Activity, Ban, CheckCircle2, Clock, ShieldAlert, UserCheck, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AnalyticsOverview } from '@/lib/api/schemas';
import { duration, money, number } from '@/lib/formatters';
import { cn } from '@/lib/cn';

interface Stat {
  label: string;
  value: string;
  icon: LucideIcon;
  alert?: boolean;
}

/** Mosaico de KPIs de operación. Jerarquía por tipografía/espaciado, no por color decorativo. */
export function KpiGrid({ data }: { data: AnalyticsOverview }) {
  const stats: Stat[] = [
    { label: 'Viajes activos', value: number(data.activeTrips), icon: Activity },
    { label: 'Conductores en línea', value: number(data.onlineDrivers), icon: UserCheck },
    {
      label: 'Pánicos abiertos',
      value: number(data.openPanics),
      icon: ShieldAlert,
      alert: data.openPanics > 0,
    },
    { label: 'Completados hoy', value: number(data.completedToday), icon: CheckCircle2 },
    { label: 'Cancelados hoy', value: number(data.cancelledToday), icon: Ban },
    { label: 'Recaudación hoy', value: money(data.revenueTodayCents), icon: Wallet },
    { label: 'Duración promedio', value: duration(data.avgDurationSeconds), icon: Clock },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
      {stats.map((s) => {
        const Icon = s.icon;
        return (
          <div
            key={s.label}
            className={cn(
              'rounded-md border bg-surface px-4 py-3',
              s.alert ? 'border-danger/40 bg-danger/5' : 'border-border',
            )}
          >
            <div className="flex items-center justify-between">
              <p className="text-xs text-ink-muted">{s.label}</p>
              <Icon
                className={cn('size-4', s.alert ? 'text-danger' : 'text-ink-subtle')}
                aria-hidden
              />
            </div>
            <p
              className={cn(
                'mt-1.5 text-2xl font-semibold tabular',
                s.alert ? 'text-danger' : 'text-ink',
              )}
            >
              {s.value}
            </p>
          </div>
        );
      })}
    </div>
  );
}
