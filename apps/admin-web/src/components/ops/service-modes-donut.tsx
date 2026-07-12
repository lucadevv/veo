'use client';

import { PieChart } from 'lucide-react';

/**
 * "Modos de servicio" (donut Fijo/Puja/Cost-share/Carpooling) del veo.pen. El backend AÚN NO expone un conteo
 * de viajes por modo (trip-service solo tiene `trip-stats`; no hay agregado by-mode), así que — regla dura:
 * NUNCA dato falso — se muestra un estado honesto en vez de un donut inventado. Se cablea cuando exista el
 * endpoint (agregado por serviceMode en trip-service → admin-bff /analytics/overview).
 */
export function ServiceModesDonut() {
  return (
    <div className="flex w-full flex-col gap-4 rounded-xl border border-black/[0.05] bg-surface p-6 shadow-3 xl:w-[380px]">
      <h2 className="font-display text-base font-bold text-ink">Modos de servicio</h2>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center">
        <span className="grid size-11 place-items-center rounded-full bg-bg text-ink-subtle">
          <PieChart className="size-5" aria-hidden />
        </span>
        <p className="text-[13px] font-medium text-ink-muted">Sin desglose por modo aún</p>
        <p className="max-w-[240px] text-xs text-ink-subtle">
          Falta el agregado de viajes por modo en el backend. Se conecta cuando el endpoint esté disponible.
        </p>
      </div>
    </div>
  );
}
