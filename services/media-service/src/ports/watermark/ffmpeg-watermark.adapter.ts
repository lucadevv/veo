/**
 * Adapter LIVE del puerto de watermark: invoca el binario `ffmpeg` por `child_process.spawn`. NO usa
 * una lib npm de ffmpeg — el dominio nunca ve ffmpeg; este es el único archivo que lo conoce.
 *
 * Por qué TEMP-FILES y no pipes crudos: el contenedor mp4 necesita un input SEEKABLE (el demuxer salta
 * a `moov`), así que NO se puede pipear el video crudo por stdin. El flujo es:
 *   1. volcar `input.source` a un temp-file de ENTRADA (mp4 seekable),
 *   2. volcar `input.text` a un temp-file de TEXTO (drawtext `textfile=` evita el infierno de escaping
 *      de `:` y `'` en el email/timestamp),
 *   3. correr ffmpeg con DOS drawtext (centro grande semi-transparente + esquina mono) → re-encode
 *      libx264 (drawtext exige re-encode), AUDIO COPIADO, downscale a una altura máxima, `+faststart`,
 *   4. devolver el temp-file de SALIDA como `Readable`, que libera los 3 temps al cerrarse.
 *
 * Robustez: TIMEOUT duro (SIGKILL) + exit-code != 0 → error TIPADO (`ExternalServiceError`) con stderr
 * truncado. La limpieza de temps es idempotente (se ejecuta exactamente una vez).
 */
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { ExternalServiceError, ValidationError } from '@veo/utils';
import type {
  BurnWatermarkInput,
  BurnWatermarkResult,
  VideoWatermarkPort,
} from './video-watermark.port';

/** Parámetros del render, inyectados desde el env (sin literales mágicos esparcidos por el código). */
export interface FfmpegWatermarkConfig {
  /** Ruta del binario ffmpeg (`WATERMARK_FFMPEG_PATH`). */
  ffmpegPath: string;
  /** Ruta del archivo TTF para drawtext (`WATERMARK_FONT_PATH`). */
  fontPath: string;
  /** Altura máxima del video derivado en px (`WATERMARK_MAX_HEIGHT`); se hace downscale, nunca upscale. */
  maxHeight: number;
  /** CRF de libx264 (`WATERMARK_CRF`): mayor = más compresión / menor calidad. */
  crf: number;
  /** Preset de libx264 (`WATERMARK_PRESET`): velocidad vs tamaño. */
  preset: string;
  /** Timeout duro del render en ms (`WATERMARK_RENDER_TIMEOUT_MS`); al excederlo se mata ffmpeg (SIGKILL). */
  renderTimeoutMs: number;
}

/**
 * Constantes del comando ffmpeg (los nombres de opciones NO se esparcen como strings mágicos). Las
 * plantillas de filtro reciben los parámetros tuneables; los colores/posiciones son fijos por diseño:
 *  - CENTRO: grande y semi-transparente, cubre el medio (un leaker no puede recortarlo sin destruir
 *    el contenido).
 *  - ESQUINA inferior derecha: mono, legible, identifica al operador.
 * drawtext NO rota → ambos son horizontales (no se inventa rotación).
 */
const FFMPEG = {
  /** No leer de stdin (evita que ffmpeg cuelgue esperando input interactivo) + sobrescribir salida. */
  flagNoStdin: '-nostdin',
  flagOverwrite: '-y',
  flagInput: '-i',
  flagVideoFilter: '-vf',
  flagVideoCodec: '-c:v',
  videoCodec: 'libx264',
  flagPreset: '-preset',
  flagCrf: '-crf',
  flagAudioCodec: '-c:a',
  /** Audio COPIADO: drawtext solo toca el video; re-encodear el audio sería costo puro. */
  audioCopy: 'copy',
  flagMovflags: '-movflags',
  /** `+faststart`: mueve `moov` al principio → el mp4 derivado es streameable progresivamente. */
  faststart: '+faststart',
  contentType: 'video/mp4',
  /** Sufijo del archivo de salida (el muxer infiere el contenedor por extensión). */
  outputSuffix: '.mp4',
  /** Tope de stderr capturado que se adjunta al error (evita arrastrar un log gigante). */
  stderrTailChars: 2000,
} as const;

/**
 * Filtro de video: downscale a altura máxima (ancho a `-2` = par más cercano, requisito de libx264) +
 * dos drawtext encadenados por coma. El `'min(...)'` va entre comillas SIMPLES de ffmpeg para que la
 * coma interna NO se interprete como separador de filtros del filtergraph (no son comillas de shell:
 * spawn no usa shell, las consume el parser de ffmpeg).
 */
function buildVideoFilter(cfg: FfmpegWatermarkConfig, textFile: string): string {
  const f = cfg.fontPath;
  const t = textFile;
  const scale = `scale=-2:'min(${cfg.maxHeight},ih)'`;
  const center =
    `drawtext=fontfile=${f}:textfile=${t}:fontcolor=white@0.30:fontsize=h/18:` +
    `box=1:boxcolor=black@0.25:boxborderw=10:x=(w-text_w)/2:y=(h-text_h)/2`;
  const corner =
    `drawtext=fontfile=${f}:textfile=${t}:fontcolor=white@0.85:fontsize=h/32:` +
    `box=1:boxcolor=black@0.45:boxborderw=6:x=w-text_w-20:y=h-text_h-20`;
  return `${scale},${center},${corner}`;
}

/** Argumentos completos de ffmpeg para el render (array → spawn sin shell, cero escaping de shell). */
function buildArgs(
  cfg: FfmpegWatermarkConfig,
  inputFile: string,
  textFile: string,
  outputFile: string,
): string[] {
  return [
    FFMPEG.flagNoStdin,
    FFMPEG.flagOverwrite,
    FFMPEG.flagInput,
    inputFile,
    FFMPEG.flagVideoFilter,
    buildVideoFilter(cfg, textFile),
    FFMPEG.flagVideoCodec,
    FFMPEG.videoCodec,
    FFMPEG.flagPreset,
    cfg.preset,
    FFMPEG.flagCrf,
    String(cfg.crf),
    FFMPEG.flagAudioCodec,
    FFMPEG.audioCopy,
    FFMPEG.flagMovflags,
    FFMPEG.faststart,
    outputFile,
  ];
}

export class FfmpegWatermarkAdapter implements VideoWatermarkPort {
  constructor(private readonly cfg: FfmpegWatermarkConfig) {}

  async burn(input: BurnWatermarkInput): Promise<BurnWatermarkResult> {
    if (input.text.trim().length === 0) {
      throw new ValidationError('El texto de watermark no puede estar vacío');
    }

    const id = randomUUID();
    const inputFile = join(tmpdir(), `veo-wm-${id}-in${FFMPEG.outputSuffix}`);
    const textFile = join(tmpdir(), `veo-wm-${id}-txt.txt`);
    const outputFile = join(tmpdir(), `veo-wm-${id}-out${FFMPEG.outputSuffix}`);
    const temps = [inputFile, textFile, outputFile];

    // Limpieza idempotente de los 3 temps: el guard asegura que corra EXACTAMENTE una vez (la registramos
    // en varios listeners del stream de salida; el primero gana, el resto es no-op).
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      await Promise.all(
        temps.map((p) => unlink(p).catch(() => undefined)), // ENOENT/temp ya borrado: idempotente.
      );
    };

    try {
      // 1+2. Volcar el video crudo a un temp SEEKABLE y el texto a su propio temp (textfile=).
      await pipeline(input.source, createWriteStream(inputFile));
      await pipeline(toTextStream(input.text), createWriteStream(textFile));

      // 3. Render: ffmpeg con re-encode de video + audio copiado. Falla → error tipado + limpieza.
      await this.runFfmpeg(buildArgs(this.cfg, inputFile, textFile, outputFile));
    } catch (err) {
      await cleanup();
      if (err instanceof ValidationError || err instanceof ExternalServiceError) throw err;
      throw new ExternalServiceError('Falló el quemado de watermark', {
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    // 4. La salida es perezosa: lee del temp-file. Al terminar (consumido o abortado) libera los 3 temps.
    const output = createReadStream(outputFile);
    output.once('close', () => void cleanup());
    output.once('end', () => void cleanup());
    output.once('error', () => void cleanup());

    return { output, contentType: FFMPEG.contentType };
  }

  /**
   * Corre ffmpeg con TIMEOUT duro (SIGKILL al excederlo) y captura stderr (truncado) para el error.
   * Resuelve con exit 0; rechaza con `ExternalServiceError` ante timeout, exit != 0 o fallo de spawn.
   */
  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.cfg.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

      let stderr = '';
      let timedOut = false;
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > FFMPEG.stderrTailChars) {
          stderr = stderr.slice(-FFMPEG.stderrTailChars); // conservar la COLA (donde ffmpeg pone el error).
        }
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL'); // duro: ffmpeg no respeta SIGTERM bajo ciertos encodes.
      }, this.cfg.renderTimeoutMs);

      child.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(
          new ExternalServiceError('No se pudo ejecutar ffmpeg', {
            ffmpegPath: this.cfg.ffmpegPath,
            cause: err.message,
          }),
        );
      });

      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new ExternalServiceError('El render de watermark superó el timeout', {
              timeoutMs: this.cfg.renderTimeoutMs,
            }),
          );
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new ExternalServiceError('ffmpeg terminó con error', {
            exitCode: code,
            signal,
            stderr: stderr.slice(-FFMPEG.stderrTailChars),
          }),
        );
      });
    });
  }
}

/** Envuelve un string en un `Readable` (UTF-8) para volcarlo a un archivo con `pipeline`, sin `any`. */
function toTextStream(text: string): Readable {
  return Readable.from([Buffer.from(text, 'utf8')]);
}
