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

/**
 * OPERABILIDAD — el MOTIVO de no-operabilidad que computa el SERVIDOR (la MISMA función que gatea el match:
 * docs SOAT/ITV vigentes Y ficha linkeada). `DOCS` = docs no vigentes; `NO_SPEC` = falta la ficha del match.
 * La UI solo lo ROTULA (no decide). Fuente única para que la LISTA y el DETALLE digan lo mismo (disciplina:
 * la UI refleja el veredicto del dueño, no lo re-deriva).
 */
export const OPERABILITY_REASON_LABELS: Record<'DOCS' | 'NO_SPEC', string> = {
  DOCS: 'docs no vigentes',
  NO_SPEC: 'sin ficha',
};

/** Rótulo del motivo de no-operabilidad (server). `null`/desconocido → "" (sin motivo legible). */
export function operabilityReasonLabel(reason: 'DOCS' | 'NO_SPEC' | null | undefined): string {
  return reason ? (OPERABILITY_REASON_LABELS[reason] ?? '') : '';
}
