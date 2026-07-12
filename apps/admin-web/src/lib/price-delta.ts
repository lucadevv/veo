/**
 * Delta de precio para el hint LIVE-DIFF de los paneles de pricing (veo.pen `SRVxK` "Precios·Editar"):
 * cuando el operador deja un valor "dirty" (draft ≠ persistido) mostramos el cambio before→after con %.
 * PURO y agnóstico de unidad/formato: opera sobre el número crudo (céntimos o bps) y el % es relativo al
 * valor anterior. La UI (PriceDiffHint) le pone el formato money/% y el tono de marca — acá solo la matemática.
 */
export interface PriceDelta {
  /** Valor persistido (antes). */
  before: number;
  /** Valor del draft (después). */
  after: number;
  /** Variación % relativa al `before` (12.5 = +12.5%). `null` cuando `before` es 0 (no hay base para el %). */
  pct: number | null;
  /** Dirección del cambio (para el signo del %). */
  up: boolean;
}

/**
 * Delta entre el valor persistido y el draft. `null` cuando NO hay cambio (o algún valor no es finito): el
 * hint solo aparece cuando el valor cambió. El % es (after − before) / before · 100; si `before` es 0 no se
 * puede calcular (división por cero) → `pct: null` y la UI muestra el before→after sin porcentaje.
 */
export function priceDelta(before: number, after: number): PriceDelta | null {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === after) return null;
  const pct = before === 0 ? null : ((after - before) / before) * 100;
  return { before, after, pct, up: after > before };
}
