'use client';

import type { OverviewSeriesPoint } from '@/lib/api/schemas';

/** Etiqueta de hora corta desde el bucket (ISO → "16"; "16:00" → "16"; fallback: los últimos 2 dígitos). */
function bucketHour(bucket: string): string {
  const hhmm = bucket.match(/(\d{1,2}):\d{2}/);
  if (hhmm) return String(Number(hhmm[1]));
  const t = Date.parse(bucket);
  if (!Number.isNaN(t)) return String(new Date(t).getHours());
  return bucket.slice(-2);
}

/**
 * Barras "Viajes por hora" fieles al veo.pen: dato REAL de `overview.series[].trips`. La barra pico (más viajes)
 * va en accent sólido; el resto en accent translúcido. Degradación honesta: sin serie → estado vacío, sin barras falsas.
 */
export function HourlyBars({ series }: { series: OverviewSeriesPoint[] }) {
  const max = series.reduce((m, p) => Math.max(m, p.trips), 0);
  const peakIdx = series.reduce((best, p, i) => (p.trips > (series[best]?.trips ?? 0) ? i : best), 0);

  return (
    <div className="flex flex-1 flex-col gap-[18px] rounded-xl border border-black/[0.05] bg-surface p-6 shadow-3">
      <h2 className="font-display text-base font-semibold text-ink">Viajes por hora</h2>
      {series.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-ink-subtle">Sin datos de las últimas horas.</p>
      ) : (
        <div className="flex items-end gap-2" style={{ height: 190 }}>
          {series.map((p, i) => {
            const h = max > 0 ? Math.max(4, Math.round((p.trips / max) * 170)) : 4;
            const highlight = i === peakIdx;
            return (
              <div key={p.bucket} className="flex flex-1 flex-col items-center gap-2">
                <div className="flex w-full flex-1 items-end justify-center">
                  <div
                    className={highlight ? 'w-full bg-accent' : 'w-full bg-accent/35'}
                    style={{ height: h, borderRadius: '6px 6px 0 0', maxWidth: 24 }}
                    title={`${p.trips} viajes`}
                  />
                </div>
                <span className="text-[11px] text-ink-subtle">{bucketHour(p.bucket)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
