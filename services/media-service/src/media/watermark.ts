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

/**
 * Clave S3/MinIO DETERMINISTA de la copia derivada (watermark quemado) de una solicitud de acceso.
 *
 * Es la ÚNICA fuente de la fórmula `${prefix}${requestId}.mp4`: la usan el worker (al escribir la copia),
 * el derecho al olvido y la retención (al borrarla). Que sea determinista es lo que permite borrar la copia
 * SIN depender del campo `renderedS3Key` en DB — clave para purgar copias HUÉRFANAS (render que subió los
 * bytes pero cuya transacción de READY falló, dejando `renderedS3Key=null`). Pura y tipada: sin estado.
 *
 * @param prefix Prefijo del bucket (config `WATERMARK_RENDERED_PREFIX`, p. ej. `watermarked/`). Nunca hardcodear.
 * @param requestId Id de la `videoAccessRequest`.
 */
export function renderedKeyFor(prefix: string, requestId: string): string {
  return `${prefix}${requestId}.mp4`;
}
