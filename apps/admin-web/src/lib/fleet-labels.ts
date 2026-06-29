/**
 * Labels legibles de la ficha técnica del vehículo (segmento + energía). Fuente ÚNICA que comparten la LISTA
 * de flota y el DETALLE `/fleet/[id]` — así el operador lee lo mismo en ambos lados. Las KEYS espejan los enums
 * del modelSpec (VehicleSegment / EnergySource); un valor sin label cae al crudo (degradación honesta).
 */
export const SEGMENT_LABELS: Record<string, string> = {
  ECONOMY: 'Económico',
  MID: 'Intermedio',
  PREMIUM: 'Premium',
};

export const ENERGY_LABELS: Record<string, string> = {
  GASOLINE_90: 'Gasolina 90',
  DIESEL: 'Diésel',
  ELECTRIC: 'Eléctrico',
};

/** Label de un segmento (cae al crudo si no está mapeado). `null`/vacío → "—". */
export function segmentLabel(segment: string | null | undefined): string {
  if (!segment) return '—';
  return SEGMENT_LABELS[segment] ?? segment;
}

/** Label de una fuente de energía (cae al crudo si no está mapeada). `null`/vacío → "—". */
export function energyLabel(energySource: string | null | undefined): string {
  if (!energySource) return '—';
  return ENERGY_LABELS[energySource] ?? energySource;
}
