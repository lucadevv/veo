/**
 * FLOTA / COMPLIANCE — vehículos, documentos, inspecciones y vencimientos (RBAC compliance/admin).
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequireStepUpMfa, Roles, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import type {
  ExpiringDocumentView,
  FleetDocumentView,
  InspectionView,
  VehicleModelReviewView,
  VehicleModelSpecView,
  VehicleView,
} from '@veo/api-client';
import { FleetService } from './fleet.service';
import {
  CreateVehicleDto,
  CreateDocumentDto,
  ReviewDocumentDto,
  CreateInspectionDto,
  ListVehiclesQueryDto,
  ListDocumentsQueryDto,
  ListInspectionsQueryDto,
  ListModelReviewQueryDto,
  ListVehicleModelsQueryDto,
  ApproveVehicleModelDto,
  ExpirationsQueryDto,
} from './dto/fleet.dto';
import { Permission } from '../policies/permission.decorator';

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

@ApiTags('fleet')
@Controller('fleet')
@Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
export class FleetController {
  constructor(private readonly fleet: FleetService) {}

  @Post('vehicles')
  @Permission('fleet:manage')
  @ApiOperation({ summary: 'Registra un vehículo' })
  createVehicle(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateVehicleDto,
  ): Promise<unknown> {
    return this.fleet.createVehicle(user, dto);
  }

  @Get('vehicles')
  @Permission('fleet:view')
  @ApiOperation({ summary: 'Lista paginada de la flota (filtro: status)' })
  listVehicles(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListVehiclesQueryDto,
  ): Promise<Page<VehicleView>> {
    return this.fleet.listVehicles(user, query);
  }

  @Get('vehicles/:id')
  @Permission('fleet:view')
  @ApiOperation({
    summary: 'Detalle de un vehículo (ENRIQUECIDO con la ficha del modelSpec, igual que la lista)',
  })
  getVehicle(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<VehicleView> {
    return this.fleet.getVehicle(user, id);
  }

  @Post('documents')
  @Permission('fleet:manage')
  @ApiOperation({ summary: 'Sube un documento (licencia/SOAT/tarjeta/ITV/antecedentes)' })
  createDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDocumentDto,
  ): Promise<FleetDocumentView> {
    return this.fleet.createDocument(user, dto);
  }

  @Get('documents/expiring')
  // Consumido SOLO por la pantalla /fleet/reviews (gate `fleet:review` en el front) → paridad.
  @Permission('fleet:review')
  @ApiOperation({
    summary: 'Cola paginada de documentos próximos a vencer (ventana de días, cursor compuesto)',
  })
  expirations(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ExpirationsQueryDto,
  ): Promise<Page<ExpiringDocumentView>> {
    return this.fleet.expirations(user, query);
  }

  @Get('documents')
  // Read compartido por /fleet/[id] (fleet:view) y /fleet/reviews (fleet:review) → mapea al denominador
  // común fleet:view (misma base de roles que review/manage; evita 403 en la pantalla view).
  @Permission('fleet:view')
  @ApiOperation({ summary: 'Lista paginada de documentos (filtros: status, ownerId)' })
  listDocuments(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListDocumentsQueryDto,
  ): Promise<Page<FleetDocumentView>> {
    return this.fleet.listDocuments(user, query);
  }

  @Post('documents/:id/review')
  @HttpCode(200)
  @Permission('fleet:review')
  @RequireStepUpMfa()
  @ApiOperation({
    summary: 'Revisión manual del operador: aprueba/rechaza un documento — exige MFA fresca',
  })
  reviewDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReviewDocumentDto,
  ): Promise<FleetDocumentView> {
    return this.fleet.reviewDocument(user, id, dto);
  }

  @Post('inspections')
  @Permission('fleet:manage')
  @ApiOperation({ summary: 'Registra una inspección técnica (ITV)' })
  createInspection(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateInspectionDto,
  ): Promise<unknown> {
    return this.fleet.createInspection(user, dto);
  }

  @Get('inspections')
  // Read compartido por /fleet/[id] (fleet:view) y /fleet/inspections (fleet:review) → denominador fleet:view.
  @Permission('fleet:view')
  @ApiOperation({ summary: 'Lista paginada de inspecciones (filtro: vehicleId)' })
  listInspections(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListInspectionsQueryDto,
  ): Promise<Page<InspectionView>> {
    return this.fleet.listInspections(user, query);
  }

  // ── Catálogo de modelos: cola de revisión del operador (B5-2.c) ──

  @Get('vehicle-models')
  @Permission('fleet:view')
  @ApiOperation({
    summary: 'Catálogo APROBADO de modelos (selector del alta admin). Filtros: vehicleType, q',
  })
  listModels(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListVehicleModelsQueryDto,
  ): Promise<Page<VehicleModelSpecView>> {
    return this.fleet.listModels(user, query);
  }

  @Get('vehicle-models/review')
  @Permission('fleet:review')
  @ApiOperation({ summary: 'Cola de revisión de modelos solicitados (default PENDING_REVIEW)' })
  listModelReview(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListModelReviewQueryDto,
  ): Promise<Page<VehicleModelReviewView>> {
    return this.fleet.listModelReview(user, query);
  }

  @Post('vehicle-models/:id/approve')
  @HttpCode(200)
  @Permission('fleet:review')
  @ApiOperation({
    summary: 'Aprueba una solicitud de modelo completando la ficha técnica (PENDING→APPROVED)',
  })
  approveModel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ApproveVehicleModelDto,
  ): Promise<VehicleModelReviewView> {
    return this.fleet.approveModel(user, id, dto);
  }

  @Post('vehicle-models/:id/reject')
  @HttpCode(200)
  @Permission('fleet:review')
  @ApiOperation({ summary: 'Rechaza una solicitud de modelo (PENDING→REJECTED)' })
  rejectModel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<VehicleModelReviewView> {
    return this.fleet.rejectModel(user, id);
  }

  @Post('vehicle-models/:id/reopen')
  @HttpCode(200)
  @Permission('fleet:review')
  @ApiOperation({
    summary: 'Reabre un modelo APROBADO para corregir su ficha técnica (APPROVED→PENDING_REVIEW)',
  })
  reopenModel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<VehicleModelReviewView> {
    return this.fleet.reopenModel(user, id);
  }
}
