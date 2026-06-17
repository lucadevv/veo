/**
 * Health base (FOUNDATION §5):
 *  - GET /health        → liveness (el proceso responde)
 *  - GET /health/ready  → readiness (dependencias OK: DB, Kafka, Redis…)
 *
 * Cada servicio provee sus ReadinessCheck vía el token READINESS_CHECKS.
 */
import { Controller, Get, Inject, Optional, ServiceUnavailableException } from '@nestjs/common';

export interface ReadinessCheck {
  name: string;
  check(): Promise<boolean>;
}

export const READINESS_CHECKS = Symbol('VEO_READINESS_CHECKS');

@Controller('health')
export class HealthController {
  constructor(
    @Optional() @Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[] = [],
  ) {}

  @Get()
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async readiness(): Promise<{ status: 'ready'; checks: Record<string, boolean> }> {
    const results = await Promise.all(
      this.checks.map(async (c) => {
        try {
          return [c.name, await c.check()] as const;
        } catch {
          return [c.name, false] as const;
        }
      }),
    );
    const map = Object.fromEntries(results);
    if (results.some(([, ok]) => !ok)) {
      throw new ServiceUnavailableException({ status: 'not_ready', checks: map });
    }
    return { status: 'ready', checks: map };
  }
}
