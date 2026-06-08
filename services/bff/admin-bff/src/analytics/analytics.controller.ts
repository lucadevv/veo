/**
 * ANALÍTICA — métricas del dashboard (ClickHouse). RBAC: dashboard de operación.
 */
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { AnalyticsService, type OverviewMetrics } from './analytics.service';

@ApiTags('analytics')
@Controller('analytics')
@Roles(
  AdminRole.SUPPORT_L2,
  AdminRole.DISPATCHER,
  AdminRole.COMPLIANCE_SUPERVISOR,
  AdminRole.FINANCE,
  AdminRole.ADMIN,
  AdminRole.SUPERADMIN,
)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Métricas agregadas reales (GPS/viajes por hora desde ClickHouse)' })
  overview(): Promise<OverviewMetrics> {
    return this.analytics.overview();
  }
}
