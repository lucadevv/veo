'use client';

import { useMemo } from 'react';
import { PieChart } from 'lucide-react';
import { number } from '@/lib/formatters';

/**
 * "Modos de servicio · viajes de hoy" (donut Fijo/Puja/Carpooling) del veo.pen. Ahora con SEAM real:
 * payment-service agrega los cobros digitales capturados de HOY por modo 3-way (mismo bucketing que el
 * revenue-por-modo) → admin-bff /analytics/overview → `byMode`. Regla dura (nunca dato falso): si no hay
 * viajes hoy (byMode vacío o todo en 0) se muestra el estado honesto, no un donut inventado.
 */

/** Un modo del desglose tal como lo devuelve el backend: bucket 3-way + conteo de viajes de hoy. */
type ByMode = { mode: string; trips: number };

/**
 * Config de los 3 buckets: etiqueta en español + token semántico del tema (SIN hex hardcodeado — `var(--token)`).
 * Mapeo consistente: FIJO=brand (azul de marca), PUJA=warn (ámbar), CARPOOLING=success (verde). El orden fija
 * el orden de los arcos y la leyenda.
 */
const MODE_CONFIG: { key: string; label: string; token: string }[] = [
  { key: 'FIXED', label: 'Fijo', token: 'var(--brand)' },
  { key: 'PUJA', label: 'Puja', token: 'var(--warn)' },
  { key: 'CARPOOLING', label: 'Carpooling', token: 'var(--success)' },
];

// Geometría del anillo SVG. C = circunferencia; cada arco toma la fracción (trips/total) de C vía dasharray.
const SIZE = 132;
const STROKE = 16;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ServiceModesDonut({ byMode }: { byMode: ByMode[] }) {
  const { segments, total } = useMemo(() => {
    // Sumamos por bucket conocido (defensa: colapsa duplicados si el backend los mandara separados).
    const counts = new Map<string, number>();
    for (const b of byMode) counts.set(b.mode, (counts.get(b.mode) ?? 0) + b.trips);
    const sum = MODE_CONFIG.reduce((acc, m) => acc + (counts.get(m.key) ?? 0), 0);
    const segs = MODE_CONFIG.map((m) => {
      const trips = counts.get(m.key) ?? 0;
      return { ...m, trips, pct: sum > 0 ? trips / sum : 0 };
    });
    return { segments: segs, total: sum };
  }, [byMode]);

  return (
    <div className="flex w-full flex-col gap-4 rounded-xl border border-black/[0.05] bg-surface p-6 shadow-3 xl:w-[380px]">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-display text-base font-semibold text-ink">Modos de servicio</h2>
        <p className="text-xs text-ink-subtle">Viajes de hoy · Lima Metropolitana</p>
      </div>

      {total === 0 ? (
        /* Estado honesto: sin cobros digitales capturados hoy → no se pinta un donut inventado. */
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center">
          <span className="grid size-11 place-items-center rounded-full bg-bg text-ink-subtle">
            <PieChart className="size-5" aria-hidden />
          </span>
          <p className="text-[13px] font-medium text-ink-muted">Sin viajes hoy</p>
          <p className="max-w-[240px] text-xs text-ink-subtle">
            Todavía no hay viajes cobrados hoy para desglosar por modo.
          </p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center gap-6 py-2 sm:flex-row sm:justify-center">
          <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
            <svg
              width={SIZE}
              height={SIZE}
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              role="img"
              aria-label={`Distribución de ${number(total)} viajes por modo`}
              className="-rotate-90"
            >
              {/* Riel de fondo del anillo. */}
              <circle
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                strokeWidth={STROKE}
                className="stroke-bg"
              />
              {(() => {
                let offset = 0;
                return segments
                  .filter((s) => s.trips > 0)
                  .map((s) => {
                    const dash = s.pct * CIRCUMFERENCE;
                    const el = (
                      <circle
                        key={s.key}
                        cx={SIZE / 2}
                        cy={SIZE / 2}
                        r={RADIUS}
                        fill="none"
                        strokeWidth={STROKE}
                        strokeLinecap="butt"
                        strokeDasharray={`${dash} ${CIRCUMFERENCE - dash}`}
                        strokeDashoffset={-offset}
                        style={{ stroke: s.token }}
                      />
                    );
                    offset += dash;
                    return el;
                  });
              })()}
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="font-display text-2xl font-bold leading-none text-ink">
                {number(total)}
              </span>
              <span className="mt-0.5 text-[11px] font-medium text-ink-subtle">viajes</span>
            </div>
          </div>

          <ul className="flex w-full flex-col gap-2.5 sm:w-auto sm:min-w-[140px]">
            {segments.map((s) => (
              <li key={s.key} className="flex items-center gap-2.5 text-[13px]">
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: s.token }}
                  aria-hidden
                />
                <span className="font-medium text-ink">{s.label}</span>
                <span className="ml-auto flex items-center gap-2 tabular-nums">
                  <span className="font-semibold text-ink">{number(s.trips)}</span>
                  <span className="text-ink-subtle">{Math.round(s.pct * 100)}%</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
