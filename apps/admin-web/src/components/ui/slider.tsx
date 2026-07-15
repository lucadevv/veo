'use client';

import { cn } from '@/lib/cn';

interface SliderProps {
  /** Etiqueta del parámetro (Outfit 14/600). */
  label: string;
  /** Sublabel explicativo (Outfit 12, ink-subtle). */
  hint?: string;
  /** Valor formateado que se muestra a la derecha (Space Mono, accent) — ej. "1.5 km", "8 s", "5". */
  displayValue: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  'aria-label'?: string;
}

/**
 * Slider canónico (fiel al frame de Radios): header (label + valor mono en accent) + sublabel + track con
 * fill en accent y knob. Usa un `<input type="range">` NATIVO (a11y + teclado gratis) estilado vía la clase
 * `veo-range` (globals.css); el fill se pinta con un gradiente atado a `--fill` (% del valor). Un solo
 * componente reutilizado por cada parámetro de cada modo — cero copy-paste.
 */
export function Slider({
  label,
  hint,
  displayValue,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
  ...aria
}: SliderProps) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold text-ink">{label}</span>
        <span className="font-mono text-sm font-semibold text-accent tabular">{displayValue}</span>
      </div>
      {hint ? <p className="-mt-1.5 text-xs text-ink-subtle">{hint}</p> : null}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={aria['aria-label'] ?? label}
        className={cn('veo-range', disabled && 'opacity-50')}
        style={{ ['--fill' as string]: `${pct}%` }}
      />
    </div>
  );
}
