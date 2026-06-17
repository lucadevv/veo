/**
 * Endpoints internos de ANALYTICS de dispatch para el dashboard admin. Montados bajo el prefijo global
 * → rutas `/api/v1/internal/analytics/...`. Protegidos por InternalIdentityGuard (firma HMAC del BFF,
 * FOUNDATION §10), mismo patrón que dispatch-radius-config.controller / heatmap.controller:
 *  - GET online-drivers → KPI "conductores en línea". Lectura: cualquier identidad interna firmada.
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalIdentityGuard } from '@veo/auth';
import { AnalyticsService } from './analytics.service';
import { OnlineDriversDto } from './dto/online-drivers.dto';

@ApiTags('analytics')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('internal/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('online-drivers')
  @ApiOperation({ summary: 'Cantidad de conductores en línea ahora (KPI del dashboard admin).' })
  async getOnlineDrivers(): Promise<OnlineDriversDto> {
    return { onlineDrivers: await this.analytics.onlineDrivers() };
  }
}
