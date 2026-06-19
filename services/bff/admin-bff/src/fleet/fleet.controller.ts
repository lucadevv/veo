/**
 * FLOTA / COMPLIANCE — vehículos, documentos, inspecciones y vencimientos (RBAC compliance/admin).
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, type AuthenticatedUser } from '@veo/auth';
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
  @ApiOperation({ summary: 'Registra un vehículo' })
  createVehicle(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateVehicleDto,
  ): Promise<unknown> {
    return this.fleet.createVehicle(user, dto);
  }

  @Get('vehicles')
  @ApiOperation({ summary: 'Lista paginada de la flota (filtro: status)' })
  listVehicles(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListVehiclesQueryDto,
  ): Promise<Page<VehicleView>> {
    return this.fleet.listVehicles(user, query);
  }

  @Get('vehicles/:id')
  @ApiOperation({ summary: 'Detalle de un vehículo' })
  getVehicle(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<unknown> {
    return this.fleet.getVehicle(user, id);
  }

  @Post('documents')
  @ApiOperation({ summary: 'Sube un documento (licencia/SOAT/tarjeta/ITV/antecedentes)' })
  createDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDocumentDto,
  ): Promise<FleetDocumentView> {
    return this.fleet.createDocument(user, dto);
  }

  @Get('documents/expiring')
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
  @ApiOperation({ summary: 'Lista paginada de documentos (filtros: status, ownerId)' })
  listDocuments(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListDocumentsQueryDto,
  ): Promise<Page<FleetDocumentView>> {
    return this.fleet.listDocuments(user, query);
  }

  @Post('documents/:id/review')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revisión manual del operador: aprueba/rechaza un documento' })
  reviewDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReviewDocumentDto,
  ): Promise<FleetDocumentView> {
    return this.fleet.reviewDocument(user, id, dto);
  }

  @Post('inspections')
  @ApiOperation({ summary: 'Registra una inspección técnica (ITV)' })
  createInspection(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateInspectionDto,
  ): Promise<unknown> {
    return this.fleet.createInspection(user, dto);
  }

  @Get('inspections')
  @ApiOperation({ summary: 'Lista paginada de inspecciones (filtro: vehicleId)' })
  listInspections(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListInspectionsQueryDto,
  ): Promise<Page<InspectionView>> {
    return this.fleet.listInspections(user, query);
  }

  // ── Catálogo de modelos: cola de revisión del operador (B5-2.c) ──

  @Get('vehicle-models')
  @ApiOperation({ summary: 'Catálogo APROBADO de modelos (selector del alta admin). Filtros: vehicleType, q' })
  listModels(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListVehicleModelsQueryDto,
  ): Promise<Page<VehicleModelSpecView>> {
    return this.fleet.listModels(user, query);
  }

  @Get('vehicle-models/review')
  @ApiOperation({ summary: 'Cola de revisión de modelos solicitados (default PENDING_REVIEW)' })
  listModelReview(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListModelReviewQueryDto,
  ): Promise<Page<VehicleModelReviewView>> {
    return this.fleet.listModelReview(user, query);
  }

  @Post('vehicle-models/:id/approve')
  @HttpCode(200)
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
  @ApiOperation({ summary: 'Rechaza una solicitud de modelo (PENDING→REJECTED)' })
  rejectModel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<VehicleModelReviewView> {
    return this.fleet.rejectModel(user, id);
  }
}
