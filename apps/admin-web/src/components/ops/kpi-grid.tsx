'use client';

import type { AnalyticsOverview } from '@/lib/api/schemas';
import { duration, money, number } from '@/lib/formatters';
import { cn } from '@/lib/cn';

interface Kpi {
  label: string;
  value: string;
  alert?: boolean;
}

/**
 * Fila de KPIs de operación (En Vivo). FIDELIDAD al frame `.pen` (EnVivo · Dashboard): 5 KPIs de VISTAZO EN
 * VIVO — las 3 señales del momento (activos ahora · conductores pingueando · pánicos abiertos) + los ingresos
 * de hoy + la duración promedio. Los agregados de CIERRE del día (margen/viajes/ticket/completados/cancelados/
 * cancelación) NO viven acá: son análisis, y su hogar es Métricas (evita el bloat que diluye la señal de "qué
 * pasa AHORA"). TODOS con seam REAL vía `GET /analytics/overview` (fan-out a trip/dispatch/panic/payment). El
 * overview NO trae deltas → no se inventan; los valores caen a 0 honestos sin actividad viva/hoy (no es stub).
 */
export function KpiGrid({ data }: { data: AnalyticsOverview }) {
  const kpis: Kpi[] = [
    { label: 'Viajes activos', value: number(data.activeTrips) },
    { label: 'Conductores en línea', value: number(data.onlineDrivers) },
    { label: 'Pánicos abiertos', value: number(data.openPanics), alert: data.openPanics > 0 },
    { label: 'Ingresos hoy', value: money(data.revenueTodayCents) },
    { label: 'Duración promedio', value: duration(data.avgDurationSeconds) },
  ];

  return (
    <div className="grid w-full grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
      {kpis.map((k) => (
        <div
          key={k.label}
          className="flex flex-col gap-2.5 rounded-[18px] border border-black/[0.05] bg-surface p-[22px] shadow-3"
        >
          <p className="text-[13px] font-medium text-ink-muted">{k.label}</p>
          <p
            className={cn(
              'font-display text-[32px] font-bold leading-none tracking-[-1px] tabular',
              k.alert ? 'text-danger' : 'text-ink',
            )}
          >
            {k.value}
          </p>
        </div>
      ))}
    </div>
  );
}
