'use client';

export interface DonutSegment {
  label: string;
  value: number;
  /** Color CSS (hex o var) del arco + dot de leyenda. */
  color: string;
}

/**
 * Donut fiel al veo.pen: anillo con arcos por segmento (conic-gradient) + centro con total, y leyenda con % a la
 * derecha. Dato REAL (los valores vienen del backend); sin datos → el llamador muestra un estado honesto, no un
 * donut vacío inventado.
 */
export function Donut({
  segments,
  centerValue,
  centerLabel,
  size = 132,
}: {
  segments: DonutSegment[];
  centerValue: string;
  centerLabel: string;
  size?: number;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  let acc = 0;
  const stops = segments
    .map((s) => {
      const start = (acc / (total || 1)) * 360;
      acc += s.value;
      const end = (acc / (total || 1)) * 360;
      return `${s.color} ${start}deg ${end}deg`;
    })
    .join(', ');

  return (
    <div className="flex items-center gap-6">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <div
          className="size-full rounded-full"
          style={{ background: total > 0 ? `conic-gradient(${stops})` : 'var(--divider)' }}
        />
        <div className="absolute inset-[18px] flex flex-col items-center justify-center rounded-full bg-surface text-center">
          <span className="font-display text-2xl font-bold tracking-[-0.5px] text-ink">{centerValue}</span>
          <span className="text-[11px] text-ink-subtle">{centerLabel}</span>
        </div>
      </div>
      <ul className="flex min-w-0 flex-1 flex-col gap-3">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-2 text-[13px]">
            <span className="size-[9px] shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
            <span className="truncate text-ink-muted">{s.label}</span>
            <span className="ml-auto shrink-0 font-semibold text-ink tabular">
              {total > 0 ? Math.round((s.value / total) * 100) : 0}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
