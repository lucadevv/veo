/**
 * FLOTA / COMPLIANCE — vehículos, documentos, inspecciones y vencimientos (RBAC compliance/admin).
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import type { FleetDocumentView } from '@veo/api-client';
import { FleetService } from './fleet.service';
import {
  CreateVehicleDto,
  CreateDocumentDto,
  ReviewDocumentDto,
  CreateInspectionDto,
  DocumentsQueryDto,
  InspectionsQueryDto,
  ExpirationsQueryDto,
} from './dto/fleet.dto';

@ApiTags('fleet')
@Controller()
@Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
export class FleetController {
  constructor(private readonly fleet: FleetService) {}

  @Post('vehicles')
  @ApiOperation({ summary: 'Registra un vehículo' })
  createVehicle(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateVehicleDto): Promise<unknown> {
    return this.fleet.createVehicle(user, dto);
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

  @Get('documents')
  @ApiOperation({ summary: 'Documentos de un titular (ownerId)' })
  listDocuments(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DocumentsQueryDto,
  ): Promise<FleetDocumentView[]> {
    return this.fleet.listDocuments(user, query.ownerId);
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
  @ApiOperation({ summary: 'Inspecciones de un vehículo' })
  listInspections(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: InspectionsQueryDto,
  ): Promise<unknown> {
    return this.fleet.listInspections(user, query.vehicleId);
  }

  @Get('compliance/expirations')
  @ApiOperation({ summary: 'Documentos próximos a vencer (ventana de días)' })
  expirations(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ExpirationsQueryDto,
  ): Promise<FleetDocumentView[]> {
    return this.fleet.expirations(user, query.days);
  }
}
