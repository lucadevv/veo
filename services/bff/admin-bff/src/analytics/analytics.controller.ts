/**
 * ANALÍTICA — KPIs del dashboard agregados desde los servicios OLTP. RBAC: dashboard de operación.
 */
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { revenueRange } from '@veo/api-client';
import { AnalyticsService, type OverviewMetrics, type RevenueMetrics } from './analytics.service';
import { RevenueQueryDto } from './dto/analytics.dto';

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

  @Get('revenue')
  @ApiOperation({
    summary: 'Métricas de revenue por rango (today/7d/30d): money-in, comisión bruta, reembolsos, margen + serie',
  })
  revenue(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: RevenueQueryDto,
  ): Promise<RevenueMetrics> {
    // Default `today` cuando el query llega sin `range` (fuente única del literal: el enum del contrato).
    return this.analytics.revenue(user, query.range ?? revenueRange.enum.today);
  }
}
