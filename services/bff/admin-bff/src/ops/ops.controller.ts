/**
 * OPS — operación: viajes (listado/detalle), conductores y operadores (aprobación RBAC).
 * RBAC base: soporte/dispatcher pueden observar; aprobaciones exigen roles superiores.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, RequireStepUpMfa, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import type { TripSummary, DriverApproval, TripDetail } from '@veo/api-client';
import {
  OpsService,
  type PendingDriver,
  type OperatorSummary,
  type CreatedOperator,
} from './ops.service';
import type { Page } from '../read-model/read-model.service';
import {
  ListTripsQueryDto,
  ListDriversQueryDto,
  CreateOperatorDto,
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
  listTrips(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListTripsQueryDto,
  ): Promise<Page<TripSummary>> {
    return this.ops.listTrips(user.roles, query);
  }

  @Get('trips/:id')
  @ApiOperation({ summary: 'Detalle agregado: trip + passenger + driver + payment + rating' })
  tripDetail(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<TripDetail> {
    return this.ops.tripDetail(user, id);
  }

  @Get('drivers')
  @ApiOperation({ summary: 'Listado de conductores (read-model)' })
  listDrivers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListDriversQueryDto,
  ): Promise<Page<DriverApproval>> {
    return this.ops.listDrivers(user.roles, query);
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
  @ApiOperation({
    summary: 'Suspende manualmente a un conductor con motivo (SAFETY · compliance/admin)',
  })
  suspendDriver(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SuspendDriverDto,
  ): Promise<void> {
    return this.ops.suspendDriver(user, id, dto.reason);
  }

  // ── Gestión de operadores (admin) ──

  @Get('operators')
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @ApiOperation({ summary: 'Listar todos los operadores (gestión de staff)' })
  listOperators(@CurrentUser() user: AuthenticatedUser): Promise<OperatorSummary[]> {
    return this.ops.listOperators(user);
  }

  @Post('operators')
  @HttpCode(200)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Crea un operador (email+roles) → INVITED + link de invitación (admin)' })
  createOperator(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOperatorDto,
  ): Promise<CreatedOperator> {
    return this.ops.createOperator(user, dto.email, dto.roles);
  }

  @Post('operators/:id/reinvite')
  @HttpCode(200)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Re-emite la invitación de un operador aún no aceptada (admin)' })
  reinviteOperator(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ inviteUrl: string; expiresAt: string }> {
    return this.ops.reinviteOperator(user, id);
  }

  @Post('operators/:id/reject')
  @HttpCode(204)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @ApiOperation({ summary: 'Rechaza un operador (admin)' })
  rejectOperator(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    return this.ops.rejectOperator(user, id);
  }
}
