/**
 * Indicador Terminus de salud de un downstream. Hace GET al /health del servicio (derivado de su
 * base REST quitando el sufijo /api/v1) con timeout corto. Comprueba que el backend está accesible.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthCheckError, HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Env } from '../../config/env.schema';

@Injectable()
export class DownstreamHealthIndicator extends HealthIndicator {
  constructor(private readonly config: ConfigService<Env, true>) {
    super();
  }

  /** Comprueba un downstream por su base REST (p.ej. IDENTITY_URL → .../health). */
  async isHealthy(key: string, baseUrlEnvKey: keyof Env): Promise<HealthIndicatorResult> {
    const base = this.config.getOrThrow<string>(baseUrlEnvKey).replace(/\/api\/v1\/?$/, '');
    const url = `${base}/health`;
    let ok = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      ok = res.ok;
    } catch {
      ok = false;
    } finally {
      clearTimeout(timer);
    }
    const result = this.getStatus(key, ok);
    if (ok) return result;
    throw new HealthCheckError(`Downstream ${key} no responde`, result);
  }
}
