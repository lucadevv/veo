import { priceDelta } from '@/lib/price-delta';

/**
 * Hint LIVE-DIFF de un campo de precio (veo.pen `SRVxK` "Precios·Editar"): "Cambió de S/1.20 → S/1.35
 * (+12.5%)". Solo se muestra cuando el valor quedó dirty (draft ≠ persistido); si no cambió → renderiza null.
 * Tono de MARCA (no semántico verde/rojo): el signo del % ya comunica la dirección — subir o bajar un precio
 * no es "bueno" ni "malo". `format` traduce el número crudo a su unidad (money `S/x` o `%`), reusando los
 * formatters de cada panel (formatSolesInput / bpsToPercentLabel). Reutilizable por los 4 paneles de pricing.
 */
export function PriceDiffHint({
  before,
  after,
  format,
}: {
  before: number;
  after: number;
  format: (value: number) => string;
}) {
  const delta = priceDelta(before, after);
  if (!delta) return null;
  const pctLabel = delta.pct === null ? null : `${delta.up ? '+' : ''}${delta.pct.toFixed(1)}%`;
  return (
    <p className="mt-1 text-right text-[11px] text-brand">
      Cambió de {format(delta.before)} → {format(delta.after)}
      {pctLabel ? ` (${pctLabel})` : null}
    </p>
  );
}
