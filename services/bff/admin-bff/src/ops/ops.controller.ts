/**
 * OPS — operación: viajes (listado/detalle), conductores y operadores (aprobación RBAC).
 * RBAC base: soporte/dispatcher pueden observar; aprobaciones exigen roles superiores.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, RequireStepUpMfa, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import type { TripSummary, DriverApproval, TripDetail } from '@veo/api-client';
import { OpsService, type PendingDriver, type PendingOperator } from './ops.service';
import type { Page } from '../read-model/read-model.service';
import {
  ListTripsQueryDto,
  ListDriversQueryDto,
  ApproveOperatorDto,
  RejectDriverDto,
  SuspendDriverDto,
} from './dto/ops.dto';

@ApiTags('ops')
@Controller('ops')
@Roles(
  AdminRole.SUPPORT_L1,
  AdminRole.SUPPORT_L2,
  AdminRole.DISPATCHER,
  AdminRole.COMPLIANCE_SUPERVISOR,
  AdminRole.ADMIN,
  AdminRole.SUPERADMIN,
)
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Get('trips')
  @ApiOperation({ summary: 'Listado/búsqueda de viajes (filtros + paginación cursor)' })
  listTrips(@Query() query: ListTripsQueryDto): Promise<Page<TripSummary>> {
    return this.ops.listTrips(query);
  }

  @Get('trips/:id')
  @ApiOperation({ summary: 'Detalle agregado: trip + passenger + driver + payment + rating' })
  tripDetail(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<TripDetail> {
    return this.ops.tripDetail(user, id);
  }

  @Get('drivers')
  @ApiOperation({ summary: 'Listado de conductores (read-model)' })
  listDrivers(@Query() query: ListDriversQueryDto): Promise<Page<DriverApproval>> {
    return this.ops.listDrivers(query);
  }

  @Get('drivers/pending')
  @ApiOperation({ summary: 'Conductores pendientes de aprobación' })
  pendingDrivers(@CurrentUser() user: AuthenticatedUser): Promise<PendingDriver[]> {
    return this.ops.listPendingDrivers(user);
  }

  @Post('drivers/:id/approve')
  @HttpCode(200)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @ApiOperation({ summary: 'Aprueba un conductor (compliance/admin)' })
  approveDriver(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ id: string; backgroundCheckStatus: string }> {
    return this.ops.approveDriver(user, id);
  }

  @Post('drivers/:id/reject')
  @HttpCode(204)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @ApiOperation({ summary: 'Rechaza un conductor con motivo opcional (compliance/admin)' })
  rejectDriver(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RejectDriverDto,
  ): Promise<void> {
    return this.ops.rejectDriver(user, id, dto.reason);
  }

  @Post('drivers/:id/suspend')
  @HttpCode(204)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @ApiOperation({ summary: 'Suspende manualmente a un conductor con motivo (SAFETY · compliance/admin)' })
  suspendDriver(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SuspendDriverDto,
  ): Promise<void> {
    return this.ops.suspendDriver(user, id, dto.reason);
  }

  // ── Gestión de operadores (admin) ──

  @Get('operators/pending')
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @ApiOperation({ summary: 'Operadores pendientes de aprobación' })
  pendingOperators(@CurrentUser() user: AuthenticatedUser): Promise<PendingOperator[]> {
    return this.ops.listPendingOperators(user);
  }

  @Post('operators/:id/approve')
  @HttpCode(200)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Aprueba un operador y asigna roles (admin)' })
  approveOperator(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ApproveOperatorDto,
  ): Promise<{ id: string; status: string; roles: string[] }> {
    return this.ops.approveOperator(user, id, dto.roles);
  }

  @Post('operators/:id/reject')
  @HttpCode(204)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @ApiOperation({ summary: 'Rechaza un operador (admin)' })
  rejectOperator(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    return this.ops.rejectOperator(user, id);
  }
}
