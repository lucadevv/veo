/**
 * Watermark dinámico para visualización de video (BR-S02).
 * Identifica de forma inequívoca quién accede (email del operador), cuándo y bajo qué solicitud,
 * para que cualquier captura de pantalla del video sea trazable a un acceso aprobado concreto.
 */
export interface WatermarkInput {
  /** Email del operador que visualiza el video. */
  operatorEmail: string;
  /** Id de la solicitud de acceso aprobada. */
  requestId: string;
  /** Momento de la aprobación/acceso. */
  at: Date;
}

/**
 * Formato determinista (clave para auditoría y testeo):
 *   `VEO · <email> · <requestId> · <ISO8601>`
 */
export function buildWatermark(input: WatermarkInput): string {
  return `VEO · ${input.operatorEmail} · ${input.requestId} · ${input.at.toISOString()}`;
}
