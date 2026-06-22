/**
 * API interna de analítica de recaudación para el dashboard admin. Montada bajo el prefijo global
 * `api/v1` → ruta efectiva `/api/v1/internal/analytics/revenue`. Protegida con InternalIdentityGuard
 * (firma HMAC del BFF · FOUNDATION §10), igual que el resto de controllers internos del servicio.
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audiences, InternalIdentityGuard, AudienceGuard, InternalAudience } from '@veo/auth';
import { AnalyticsService, type RevenueAnalytics } from './analytics.service';

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
}
