/**
 * Health del BFF (Terminus). Liveness simple en /health/live; readiness en /health comprueba
 * Redis + un downstream (identity-service). Excluido del prefijo global /api/v1.
 */
import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, type HealthCheckResult } from '@nestjs/terminus';
import { Public } from '@veo/auth';
import { RedisHealthIndicator } from './redis.health-indicator';
import { DownstreamHealthIndicator } from './downstream.health-indicator';

// @Public() a nivel de clase: el JwtAuthGuard global (APP_GUARD en app.module) respondía 401
// a los probes de k8s (liveness/readiness). El guard lee IS_PUBLIC_KEY con getAllAndOverride
// sobre [handler, class], por lo que marcar la clase exime ambos endpoints (/health y /health/live).
@Public()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly redis: RedisHealthIndicator,
    private readonly downstream: DownstreamHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  readiness(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.redis.isHealthy('redis'),
      () => this.downstream.isHealthy('identity', 'IDENTITY_URL'),
    ]);
  }

  @Get('live')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
