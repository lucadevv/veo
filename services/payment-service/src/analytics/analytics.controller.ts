/**
 * API interna de analítica de recaudación para el dashboard admin. Montada bajo el prefijo global
 * `api/v1` → ruta efectiva `/api/v1/internal/analytics/revenue`. Protegida con InternalIdentityGuard
 * (firma HMAC del BFF · FOUNDATION §10), igual que el resto de controllers internos del servicio.
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audiences, InternalIdentityGuard, AudienceGuard, InternalAudience } from '@veo/auth';
import {
  AnalyticsService,
  RevenueRange,
  isRevenueRange,
  type RevenueAnalytics,
  type RevenueRangeMetrics,
} from './analytics.service';

// KPI de recaudación = SOLO el dashboard admin (admin-rail). NO service-rail (mínimo privilegio ·
// ADR-014 §5.5): @Audiences(admin-rail) + AudienceGuard restaura el fence fail-closed que la membresía global
// daba antes de admitir service-rail por charge/debt/GetPayment.
@ApiTags('analytics')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard, AudienceGuard)
@Audiences(InternalAudience.ADMIN_RAIL)
@Controller('internal/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('revenue')
  @ApiOperation({
    summary: 'KPI de recaudación: capturado hoy (America/Lima) + serie de revenue por hora (24h)',
  })
  revenue(): Promise<RevenueAnalytics> {
    return this.analytics.revenue();
  }

  // Pantalla "Métricas" del admin: money-in + comisión bruta + reembolsos + serie, por RANGO (today/7d/30d).
  // El `range` viene ya validado por el admin-bff (DTO); acá se re-estrecha con `isRevenueRange` (defensa en
  // profundidad) y cae a `today` si llega ausente/ inválido — el interno nunca revienta por un query malformado.
  @Get('revenue-metrics')
  @ApiOperation({
    summary: 'Métricas de revenue por rango (today/7d/30d, TZ Lima): money-in + comisión + reembolsos + serie',
  })
  @ApiQuery({ name: 'range', required: false, enum: Object.values(RevenueRange) })
  revenueMetrics(@Query('range') range?: string): Promise<RevenueRangeMetrics> {
    return this.analytics.revenueMetrics(isRevenueRange(range) ? range : RevenueRange.TODAY);
  }
}
