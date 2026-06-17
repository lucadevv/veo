/**
 * ANALÍTICA — KPIs del dashboard agregados desde los servicios OLTP. RBAC: dashboard de operación.
 */
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, type AuthenticatedUser } from '@veo/auth';
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
  @ApiOperation({
    summary: 'KPIs del dashboard agregados en vivo desde trip/dispatch/panic/payment',
  })
  overview(@CurrentUser() user: AuthenticatedUser): Promise<OverviewMetrics> {
    return this.analytics.overview(user);
  }
}
