/**
 * Wiring del puerto de watermark: adapter `live` (`FfmpegWatermarkAdapter`, invoca el binario ffmpeg)
 * o `sandbox` (`SandboxWatermarkAdapter`, passthrough determinista sin ffmpeg). Selección por
 * `VEO_WATERMARK_MODE` (mismo patrón que `VEO_STORAGE_MODE`). Exporta el token `VIDEO_WATERMARK_PORT`.
 */
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VIDEO_WATERMARK_PORT, type VideoWatermarkPort } from './video-watermark.port';
import { FfmpegWatermarkAdapter } from './ffmpeg-watermark.adapter';
import { SandboxWatermarkAdapter } from './sandbox-watermark.adapter';
import type { Env } from '../../config/env.schema';

const watermarkProvider: Provider = {
  provide: VIDEO_WATERMARK_PORT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): VideoWatermarkPort => {
    if (config.getOrThrow<string>('VEO_WATERMARK_MODE') !== 'live') {
      return new SandboxWatermarkAdapter();
    }
    return new FfmpegWatermarkAdapter({
      ffmpegPath: config.getOrThrow<string>('WATERMARK_FFMPEG_PATH'),
      fontPath: config.getOrThrow<string>('WATERMARK_FONT_PATH'),
      maxHeight: config.getOrThrow<number>('WATERMARK_MAX_HEIGHT'),
      crf: config.getOrThrow<number>('WATERMARK_CRF'),
      preset: config.getOrThrow<string>('WATERMARK_PRESET'),
      renderTimeoutMs: config.getOrThrow<number>('WATERMARK_RENDER_TIMEOUT_MS'),
    });
  },
};

@Module({ providers: [watermarkProvider], exports: [VIDEO_WATERMARK_PORT] })
export class WatermarkModule {}
