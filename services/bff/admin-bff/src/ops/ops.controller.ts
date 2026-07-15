/**
 * OPS — operación: viajes (listado/detalle), conductores y operadores (aprobación RBAC).
 * RBAC base: soporte/dispatcher pueden observar; aprobaciones exigen roles superiores.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, RequireStepUpMfa, type AuthenticatedUser } from '@veo/auth';
import { RequireStepUpMfaForPolicy } from '../policies/require-step-up-for-policy.decorator';
import { Permission } from '../policies/permission.decorator';
import { AdminRole } from '@veo/shared-types';
import type {
  TripSummary,
  DriverApproval,
  DriverCounts,
  VehicleCounts,
  ReviewQueueSummary,
  TripDetail,
  DriverDetail,
  DniFaceMatchResult,
  OperatorDetail,
  LiveCabin,
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
  ChangeOperatorRolesDto,
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
  @Permission('trips:view')
  @ApiOperation({ summary: 'Listado/búsqueda de viajes (filtros + paginación cursor)' })
  listTrips(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListTripsQueryDto,
  ): Promise<Page<TripSummary>> {
    return this.ops.listTrips(user, query);
  }

  @Get('trips/:id')
  @Permission('trips:view')
  @ApiOperation({ summary: 'Detalle agregado: trip + passenger + driver + payment + rating' })
  tripDetail(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<TripDetail> {
    return this.ops.tripDetail(user, id);
  }

  // Muro de cámaras EN VIVO (pantalla Seguridad · gate `live:view` = Compliance+). Sobre-restringe respecto del
  // @Roles amplio de la clase ops A PROPÓSITO (defensa en profundidad: solo Compliance+ ve las cabinas — el
  // front ya lo gatea con can(live:view) y media re-autoriza el feed con doble-auth). No abre video: solo el tile.
  @Get('live-cabins')
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Permission('live:view')
  @ApiOperation({ summary: 'Cabinas de los viajes en curso para el muro de cámaras (tiles enriquecidos)' })
  liveCabins(@CurrentUser() user: AuthenticatedUser): Promise<LiveCabin[]> {
    return this.ops.listLiveCabins(user);
  }

  @Get('drivers')
  @Permission('drivers:view')
  @ApiOperation({ summary: 'Listado de conductores (read-model)' })
  listDrivers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListDriversQueryDto,
  ): Promise<Page<DriverApproval>> {
    return this.ops.listDrivers(user, query);
  }

  @Get('drivers/pending')
  @Permission('drivers:view')
  @ApiOperation({ summary: 'Conductores pendientes de aprobación' })
  pendingDrivers(@CurrentUser() user: AuthenticatedUser): Promise<PendingDriver[]> {
    return this.ops.listPendingDrivers(user);
  }

  // ANTES de drivers/:id: Nest matchea por orden y ':id' capturaría "summary". Conteo por estado (stat cards).
  @Get('drivers/summary')
  @Permission('drivers:view')
  @ApiOperation({ summary: 'Conteo de conductores por estado de antecedentes (stat cards)' })
  driversSummary(@CurrentUser() user: AuthenticatedUser): Promise<DriverCounts> {
    return this.ops.driversSummary(user);
  }

  // Estrechado a los roles de `fleet:view` (cierra el reporte de Ola B): su pantalla (/fleet) ya gatea con
  // fleet:view, así que sobre-restringir el @Roles amplio de la clase ops no le quita el dato a nadie que vea
  // la pantalla — y permite gobernarlo con @Permission sin romper el invariante base ⊇ @Roles del overlay.
  @Get('vehicles/summary')
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Permission('fleet:view')
  @ApiOperation({ summary: 'Conteo de vehículos por estado documental (stat cards)' })
  vehiclesSummary(@CurrentUser() user: AuthenticatedUser): Promise<VehicleCounts> {
    return this.ops.vehiclesSummary(user);
  }

  // Mismo cierre que vehicles/summary: la pantalla (/fleet/reviews) gatea con fleet:review, cuya base es
  // Compliance+ → estrechar el @Roles heredado de la clase ops mantiene base ⊇ @Roles y gobierna el endpoint.
  @Get('reviews/summary')
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Permission('fleet:review')
  @ApiOperation({ summary: 'Conteo de las colas de revisión (cola unificada de Revisiones)' })
  reviewsSummary(@CurrentUser() user: AuthenticatedUser): Promise<ReviewQueueSummary> {
    return this.ops.reviewsSummary(user);
  }

  @Get('drivers/:id')
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Permission('drivers:view')
  // PBAC (ADR-024 §5 · `pii.reveal-stepup`): este detalle REVELA el DNI completo del conductor. Hoy solo RBAC
  // (Compliance+); cuando el superadmin ENABLE la política, exige además MFA fresca dentro de su ventana propia
  // (default 600s, distinta del auth.stepup de 300s). DISABLED por default → comportamiento de hoy intacto.
  @RequireStepUpMfaForPolicy('pii.reveal-stepup')
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
  @Permission('drivers:approve')
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
  // Paso de verificación del flujo de aprobación de compliance (@Roles == drivers:approve base) → drivers:approve.
  @Permission('drivers:approve')
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
  @Permission('drivers:approve')
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
  // reject es el otro veredicto del mismo flujo de aprobación (front lo gatea con drivers:approve).
  @Permission('drivers:approve')
  // Par de approve (BR-S07 / FOUNDATION §7): rechazar un conductor es el otro veredicto de compliance — mismo
  // riesgo de sabotaje (una sesión comprometida rechazando conductores legítimos) → exige TOTP fresco, no solo RBAC.
  @RequireStepUpMfa()
  @ApiOperation({
    summary: 'Rechaza un conductor con motivo opcional (compliance/admin · exige step-up MFA)',
  })
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
  // Acción de compliance dentro de la revisión del conductor (@Roles == drivers:approve base) → drivers:approve.
  @Permission('drivers:approve')
  @ApiOperation({
    summary:
      'Destraba la verificación biométrica del conductor (central · regla #1: solo la central destraba)',
  })
  unlockBiometric(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    return this.ops.unlockBiometric(user, id);
  }

  @Post('drivers/:id/suspend')
  @HttpCode(204)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Permission('drivers:suspend')
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
  // Inverso de suspend, mismo ciclo de suspensión (front gatea el componente con drivers:suspend) → drivers:suspend.
  @Permission('drivers:suspend')
  @ApiOperation({
    summary: 'Reactiva a un conductor (solo suspensiones disciplinarias · compliance/admin)',
  })
  reactivateDriver(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    return this.ops.reactivateDriver(user, id);
  }

  @Post('drivers/:id/reactivate-compliance')
  @HttpCode(204)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Permission('drivers:suspend')
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
  @Permission('drivers:delete')
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
  @Permission('operators:view')
  @ApiOperation({ summary: 'Listar todos los operadores (gestión de staff)' })
  listOperators(@CurrentUser() user: AuthenticatedUser): Promise<OperatorSummary[]> {
    return this.ops.listOperators(user);
  }

  @Post('operators')
  @HttpCode(200)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Permission('operators:create')
  @RequireStepUpMfa()
  @ApiOperation({
    summary: 'Crea un operador (email+roles) → INVITED + link de invitación (admin)',
  })
  createOperator(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOperatorDto,
  ): Promise<CreatedOperator> {
    return this.ops.createOperator(user, dto.email, dto.roles);
  }

  @Get('operators/:id')
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Permission('operators:view')
  @ApiOperation({
    summary: 'Detalle de un operador: core + 2FA + último acceso + permisos efectivos + sesiones (admin)',
  })
  operatorDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<OperatorDetail> {
    return this.ops.operatorDetail(user, id);
  }

  @Post('operators/:id/roles')
  @HttpCode(200)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  // Cambiar roles es una MUTACIÓN de privilegio (no la gestión-de-fila de reinvite/reject) → operators:create,
  // el mismo permiso del alta con grant de roles. Step-up MFA + anti-escalada (espejo de createOperator).
  @Permission('operators:create')
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Cambia los roles RBAC de un operador (admin · step-up MFA + anti-escalada)' })
  changeOperatorRoles(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ChangeOperatorRolesDto,
  ): Promise<OperatorDetail> {
    return this.ops.changeOperatorRoles(user, id, dto.roles);
  }

  @Post('operators/:id/suspend')
  @HttpCode(204)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Permission('operators:create')
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Suspende un operador (status → SUSPENDED · admin · step-up MFA)' })
  suspendOperator(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.ops.suspendOperator(user, id);
  }

  @Post('operators/:id/remove')
  @HttpCode(204)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Permission('operators:create')
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Elimina (soft-delete) un operador (admin · step-up MFA)' })
  removeOperator(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.ops.removeOperator(user, id);
  }

  @Post('operators/:id/sessions/:sessionId/revoke')
  @HttpCode(204)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Permission('operators:create')
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Revoca UNA sesión activa de un operador (admin · step-up MFA)' })
  revokeOperatorSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
  ): Promise<void> {
    return this.ops.revokeOperatorSession(user, id, sessionId);
  }

  @Post('operators/:id/reinvite')
  @HttpCode(200)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN)
  // reinvite/reject son gestión del operador ya listado; la matriz base los agrupa bajo operators:view
  // (front operator-actions gatea con can(operators:view)). operators:create es solo el alta inicial.
  @Permission('operators:view')
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
  @Permission('operators:view')
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Rechaza un operador (admin)' })
  rejectOperator(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    return this.ops.rejectOperator(user, id);
  }
}
