/**
 * Puerto de QUEMADO (burn-in) de watermark en video (FOUNDATION §9, BR-S02). El watermark de
 * trazabilidad (operador · requestId · timestamp) se incrusta en CADA frame del video server-side,
 * detrás de este puerto: el binario/SDK de ffmpeg JAMÁS se filtra al dominio (regla D de SOLID).
 *
 * - `live`: `FfmpegWatermarkAdapter` — invoca el binario `ffmpeg` (re-encode con drawtext).
 * - `sandbox`: `SandboxWatermarkAdapter` — passthrough determinista, SIN ffmpeg (tests del Lote 3).
 *
 * La interfaz habla en tipos del CORE de Node (`Readable`/`string`), nunca en tipos de ffmpeg ni en
 * rutas de archivos temporales: el dominio entrega un stream de video crudo + el texto ya compuesto y
 * recibe un stream de video con el watermark quemado. Todo el detalle (temp-files, codecs, timeouts)
 * vive SOLO dentro del adapter `live`.
 */
import type { Readable } from 'node:stream';

/** Token DI del puerto (mismo estilo que `STORAGE_PORT`). */
export const VIDEO_WATERMARK_PORT = Symbol('VIDEO_WATERMARK_PORT');

export interface BurnWatermarkInput {
  /** Video crudo (viene de `StoragePort.getObjectStream`). El adapter lo materializa a un temp seekable. */
  source: Readable;
  /** La línea de watermark ya compuesta (operador · requestId · timestamp), ver `buildWatermark`. */
  text: string;
}

export interface BurnWatermarkResult {
  /**
   * Video con el watermark quemado. Es un `Readable` perezoso (lee del temp-file de salida): libera sus
   * temp-files al terminar (`end`/`close`/`error`). El llamador DEBE consumirlo (pipe a `uploadObject`)
   * — si lo abandona sin consumir, los temps se liberan igual al cerrarse el stream.
   */
  output: Readable;
  /** Content-Type del derivado. Siempre `'video/mp4'`. */
  contentType: string;
}

export interface VideoWatermarkPort {
  /**
   * Quema `input.text` en cada frame de `input.source` y devuelve el video derivado como stream.
   * Lanza un error TIPADO de dominio (`ValidationError`/`ExternalServiceError`) ante entrada inválida,
   * timeout de render, o fallo del motor de video.
   */
  burn(input: BurnWatermarkInput): Promise<BurnWatermarkResult>;
}
