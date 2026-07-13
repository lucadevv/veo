'use client';

import { useId, useState } from 'react';
import type { BaseFareView } from '@/lib/api/schemas';
import { money } from '@/lib/formatters';

/**
 * Simulador de tarifa (veo.pen · frame cuH7M) — herramienta de PREVIEW para el admin: aplica la fórmula
 * on-demand global (banderazo + per-km + per-min) a una distancia/tiempo de prueba y muestra el desglose y
 * el total estimado en FIJO. Es CÓMPUTO LOCAL PURO (sin seam nuevo): lee los mismos valores que la card
 * "Tarifa base" carga del backend (`config: BaseFareView`) y los inputs son estado local.
 *
 * DECISIÓN (valor persistido, no draft): usa `config.*Cents` (lo que el bff devolvió), NO el borrador sin
 * guardar del panel de al lado. Así el simulador refleja la fórmula VIGENTE (la que realmente cobra hoy);
 * si el admin edita la tarifa base arriba y aún no guarda, el simulador no miente con un valor no aplicado.
 *
 * NOTA (tarifa mínima): la fórmula global NO tiene piso — la "tarifa mínima" (`niCents`) es PER-OFERTA
 * (catálogo, ADR-023 §3), se aplica aguas abajo en el FIXED dispatch strategy `max(round(fare×mult), ni)`.
 * Por eso el total del simulador es la suma limpia, sin clamp global.
 */

/** Cantidad de prueba: vacío/NaN/negativo → 0 (el término suma 0, nunca NaN). */
function toQty(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function FareSimulatorCard({ config }: { config: BaseFareView }) {
  const distanceId = useId();
  const timeId = useId();
  const [distance, setDistance] = useState('8');
  const [time, setTime] = useState('20');

  const km = toQty(distance);
  const min = toQty(time);

  const distanceCents = Math.round(km * config.perKmCents);
  const timeCents = Math.round(min * config.perMinCents);
  const totalCents = config.baseFareCents + distanceCents + timeCents;

  const rows: { label: string; value: number }[] = [
    { label: 'Banderazo', value: config.baseFareCents },
    { label: `Distancia · ${km} km`, value: distanceCents },
    { label: `Tiempo · ${min} min`, value: timeCents },
  ];

  return (
    <div className="rounded-[18px] border border-black/[0.05] bg-surface p-[22px] shadow-3">
      <div className="flex flex-col gap-4">
        <h3 className="font-display text-base font-semibold text-ink">Simulador de tarifa</h3>

        {/* Inputs de prueba (i-Distancia / i-Tiempo): estado local, cajas recesadas. */}
        <div className="flex gap-2.5">
          <div className="flex flex-1 flex-col gap-1 rounded-md border border-border bg-bg p-3">
            <label htmlFor={distanceId} className="text-[11px] font-semibold text-ink-subtle">
              Distancia
            </label>
            <div className="flex items-baseline gap-1">
              <input
                id={distanceId}
                type="number"
                inputMode="decimal"
                min="0"
                step="0.5"
                value={distance}
                onChange={(e) => setDistance(e.target.value)}
                className="tabular w-full min-w-0 bg-transparent font-mono text-base font-bold text-ink outline-none"
              />
              <span className="shrink-0 font-mono text-sm text-ink-subtle">km</span>
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-1 rounded-md border border-border bg-bg p-3">
            <label htmlFor={timeId} className="text-[11px] font-semibold text-ink-subtle">
              Tiempo
            </label>
            <div className="flex items-baseline gap-1">
              <input
                id={timeId}
                type="number"
                inputMode="numeric"
                min="0"
                step="1"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="tabular w-full min-w-0 bg-transparent font-mono text-base font-bold text-ink outline-none"
              />
              <span className="shrink-0 font-mono text-sm text-ink-subtle">min</span>
            </div>
          </div>
        </div>

        {/* Desglose: label izquierda, monto derecha, divisor inferior. */}
        <div className="flex flex-col">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex items-center justify-between border-b border-border py-2.5"
            >
              <span className="text-sm text-ink-muted">{row.label}</span>
              <span className="tabular font-mono text-sm font-semibold text-ink">
                {money(row.value)}
              </span>
            </div>
          ))}
        </div>

        {/* Total estimado (FIJO) — el precio exacto en FIJO / el sugerido en PUJA. */}
        <div className="flex items-center justify-between rounded-md bg-brand/5 px-3.5 py-3">
          <span className="text-sm font-semibold text-ink">Total estimado (FIJO)</span>
          <span className="tabular font-display text-xl font-bold text-brand">
            {money(totalCents)}
          </span>
        </div>
      </div>
    </div>
  );
}
