/**
 * OPS — operación: viajes (listado/detalle), conductores y operadores (aprobación RBAC).
 * RBAC base: soporte/dispatcher pueden observar; aprobaciones exigen roles superiores.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, RequireStepUpMfa, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import type {
  TripSummary,
  DriverApproval,
  DriverCounts,
  VehicleCounts,
  TripDetail,
  DriverDetail,
  DniFaceMatchResult,
} from '@veo/api-client';
import {
  OpsService,
  type PendingDriver,
  type OperatorSummary,
  type CreatedOperator,
  type DriverPurgeSummary,
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
    return this.ops.listDrivers(user, query);
  }

  @Get('drivers/pending')
  @ApiOperation({ summary: 'Conductores pendientes de aprobación' })
  pendingDrivers(@CurrentUser() user: AuthenticatedUser): Promise<PendingDriver[]> {
    return this.ops.listPendingDrivers(user);
  }

  // ANTES de drivers/:id: Nest matchea por orden y ':id' capturaría "summary". Conteo por estado (stat cards).
  @Get('drivers/summary')
  @ApiOperation({ summary: 'Conteo de conductores por estado de antecedentes (stat cards)' })
  driversSummary(@CurrentUser() user: AuthenticatedUser): Promise<DriverCounts> {
    return this.ops.driversSummary(user);
  }

  @Get('vehicles/summary')
  @ApiOperation({ summary: 'Conteo de vehículos por estado documental (stat cards)' })
  vehiclesSummary(@CurrentUser() user: AuthenticatedUser): Promise<VehicleCounts> {
    return this.ops.vehiclesSummary(user);
  }

  @Get('drivers/:id')
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @ApiOperation({
    summary: 'Detalle de revisión de un conductor: core + biométrico + documentos (URLs firmadas)',
  })
  driverDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<DriverDetail> {
    return this.ops.driverDetail(user, id);
  }

  @Post('drivers/:id/approve')
  @HttpCode(200)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  // BR-S07 / FOUNDATION §7: aprobar un conductor es la acción sensible por excelencia (lo habilita a operar,
  // con implicancias de seguridad Ley 29733) → exige TOTP FRESCO, no solo RBAC. Los hermanos menos críticos
  // (reactivate-compliance, DELETE driver, grant/reject operator) ya lo tenían; approve quedó sin él (drift).
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Aprueba un conductor (compliance/admin · exige step-up MFA)' })
  approveDriver(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ id: string; backgroundCheckStatus: string }> {
    return this.ops.approveDriver(user, id);
  }

  @Post('drivers/:id/dni-face-match')
  @HttpCode(200)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @ApiOperation({
    summary:
      'Verificar rostro DNI↔selfie: baja la foto FRONT del DNI de S3 y la cotea con la biometría enrolada (BINDING · 3C)',
  })
  dniFaceMatch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<DniFaceMatchResult> {
    return this.ops.runDniFaceMatch(user, id);
  }

  @Post('drivers/:id/license-face-match')
  @HttpCode(200)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @ApiOperation({
    summary:
      'Verificar rostro licencia↔selfie: baja la foto del brevete de S3 y la cotea con la biometría enrolada (BINDING · Lote C)',
  })
  licenseFaceMatch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<DniFaceMatchResult> {
    return this.ops.runLicenseFaceMatch(user, id);
  }

  @Post('drivers/:id/reject')
  @HttpCode(204)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  // Par de approve (BR-S07 / FOUNDATION §7): rechazar un conductor es el otro veredicto de compliance — mismo
  // riesgo de sabotaje (una sesión comprometida rechazando conductores legítimos) → exige TOTP fresco, no solo RBAC.
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Rechaza un conductor con motivo opcional (compliance/admin · exige step-up MFA)' })
  rejectDriver(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RejectDriverDto,
  ): Promise<void> {
    return this.ops.rejectDriver(user, id, dto.reason);
  }

  @Post('drivers/:id/biometric/unlock')
  @HttpCode(204)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @ApiOperation({
    summary:
      'Destraba la verificación biométrica del conductor (central · regla #1: solo la central destraba)',
  })
  unlockBiometric(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.ops.unlockBiometric(user, id);
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

  @Post('drivers/:id/reactivate')
  @HttpCode(204)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @ApiOperation({
    summary: 'Reactiva a un conductor (solo suspensiones disciplinarias · compliance/admin)',
  })
  reactivateDriver(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.ops.reactivateDriver(user, id);
  }

  @Post('drivers/:id/reactivate-compliance')
  @HttpCode(204)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @RequireStepUpMfa()
  @ApiOperation({
    summary:
      'Override manual: reactiva a un conductor suspendido por documentos/ITV vencidos (DOCUMENT_EXPIRED + ' +
      'INSPECTION_EXPIRED). UNA escritura autoritativa: levanta los holds en identity (sin paso en fleet — el ' +
      'latch fue eliminado con el refactor a holds). Compliance+ con step-up MFA.',
  })
  reactivateDriverForCompliance(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.ops.reactivateDriverForCompliance(user, id);
  }

  @Delete('drivers/:id')
  @HttpCode(200)
  @Roles(AdminRole.SUPERADMIN)
  @RequireStepUpMfa()
  @ApiOperation({
    summary:
      'HARD purge en cascada de un conductor NO-OPERADO (re-registro): identity + fleet + media + ' +
      'proyección. Bloquea con 409 si tiene historial de viajes. SUPERADMIN + step-up MFA.',
  })
  purgeDriver(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<DriverPurgeSummary> {
    return this.ops.purgeDriver(user, id);
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
