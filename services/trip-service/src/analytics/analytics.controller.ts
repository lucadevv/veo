/**
 * Endpoint interno de stats del dashboard admin (KPIs reales). Montado bajo el prefijo global `api/v1`
 * → ruta efectiva `/api/v1/internal/analytics/trip-stats`. Protegido por InternalIdentityGuard (firma
 * HMAC del BFF, FOUNDATION §10): lectura para cualquier identidad interna firmada (el admin-bff lo
 * consume para el panel). Mismo patrón que pricing/catalog (controllers internos existentes).
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InternalIdentityGuard } from '@veo/auth';
import {
  AnalyticsService,
  type OfferingMetrics,
  type TripStatsView,
} from './analytics.service';
import { OfferingMetricsQueryDto } from './dto/offering-metrics-query.dto';

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

  // Página-detalle del catálogo admin (board HjDvx): métricas 30d de UNA oferta (nº de viajes COMPLETADOS +
  // facturación bruta Σ fareCents). Datos PROPIOS de trip-service por `Trip.category` = offering id. El
  // admin-bff (catalog:view) lo consume; el `offeringId` se re-valida acá contra el enum del catálogo.
  @Get('offering-metrics')
  @ApiQuery({ name: 'offeringId', required: true, description: 'Id de la oferta (OfferingId conocido)' })
  @ApiOperation({
    summary:
      'Métricas 30d de UNA oferta del catálogo (solo datos de trip-service): viajes completados + ' +
      'facturación bruta (Σ fareCents) por Trip.category. Sin revenue neto ni rating por oferta (sin fuente).',
  })
  getOfferingMetrics(@Query() query: OfferingMetricsQueryDto): Promise<OfferingMetrics> {
    return this.analytics.getOfferingMetrics(query.offeringId);
  }
}
