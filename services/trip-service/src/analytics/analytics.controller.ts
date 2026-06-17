/**
 * Endpoint interno de stats del dashboard admin (KPIs reales). Montado bajo el prefijo global `api/v1`
 * → ruta efectiva `/api/v1/internal/analytics/trip-stats`. Protegido por InternalIdentityGuard (firma
 * HMAC del BFF, FOUNDATION §10): lectura para cualquier identidad interna firmada (el admin-bff lo
 * consume para el panel). Mismo patrón que pricing/catalog (controllers internos existentes).
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalIdentityGuard } from '@veo/auth';
import { AnalyticsService, type TripStatsView } from './analytics.service';

@ApiTags('analytics')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('internal/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('trip-stats')
  @ApiOperation({
    summary:
      'KPIs reales del dashboard admin (solo datos de trip-service): activos ahora, completados/' +
      'cancelados hoy (America/Lima), ETA promedio de activos y viajes por hora (últimas 24h).',
  })
  getTripStats(): Promise<TripStatsView> {
    return this.analytics.getTripStats();
  }
}
