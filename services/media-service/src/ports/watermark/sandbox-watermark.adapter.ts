/**
 * Adapter SANDBOX del puerto de watermark: determinista, SIN ffmpeg (los tests del Lote 3 corren sin el
 * binario). `burn()` materializa el video crudo a un `Buffer` y lo devuelve TAL CUAL (passthrough
 * identidad: mismos bytes de entrada y salida) + `contentType:'video/mp4'`.
 *
 * `lastBurnText` expone de forma OBSERVABLE el último texto recibido, para que los tests aserten que la
 * línea de watermark (operador · requestId · timestamp) se compuso bien antes de llegar al puerto.
 */
import { Readable } from 'node:stream';
import type {
  BurnWatermarkInput,
  BurnWatermarkResult,
  VideoWatermarkPort,
} from './video-watermark.port';

/** Junta los chunks de un `Readable` en un `Buffer` (sin `any`: el chunk del stream se tipa). */
async function collectStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export class SandboxWatermarkAdapter implements VideoWatermarkPort {
  /** Content-Type fijo del derivado (espejo del adapter live). */
  private static readonly CONTENT_TYPE = 'video/mp4';

  /** Último texto de watermark recibido (observable para tests). `null` hasta el primer `burn()`. */
  public lastBurnText: string | null = null;

  async burn(input: BurnWatermarkInput): Promise<BurnWatermarkResult> {
    this.lastBurnText = input.text;
    // Passthrough identidad: materializa el crudo y lo devuelve sin tocar los bytes (sin ffmpeg).
    const bytes = await collectStream(input.source);
    return { output: Readable.from(bytes), contentType: SandboxWatermarkAdapter.CONTENT_TYPE };
  }
}
