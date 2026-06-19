import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import {
  InternalIdentityGuard,
  RolesGuard,
  Roles,
  AudienceGuard,
  Audiences,
  InternalAudience,
  CurrentUser,
  type AuthenticatedUser,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { DocumentsService } from './documents.service';
import { CreateDocumentDto, ReviewDocumentDto } from './dto/document.dto';
import { FleetDocumentStatus, type FleetDocument } from '../generated/prisma';
import type { Page } from '../infra/pagination';

@ApiTags('documents')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  // CAPA 1 transporte (confused deputy, FOUNDATION §14): subir un documento solo tiene callers
  // legítimos en driver-rail (conductor sube SUS docs) y admin-rail (operador con RBAC). public-rail
  // y service-rail NO tienen razón legítima de crear docs → AudienceGuard los corta fail-closed antes
  // de tocar dominio. InternalIdentityGuard (a nivel clase) corre primero y adjunta req.user.
  @UseGuards(AudienceGuard)
  @Audiences(InternalAudience.DRIVER_RAIL, InternalAudience.ADMIN_RAIL)
  @Post()
  @ApiOperation({ summary: 'Subir un documento (queda PENDING_REVIEW). BR-I04' })
  create(
    @Body() dto: CreateDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<FleetDocument> {
    // Anti-IDOR: fleet valida PERTENENCIA contra el principal autenticado (identidad interna firmada),
    // no confía ciegamente en ownerId del body. DRIVER → driverId firmado; VEHICLE → dueño del vehículo.
    return this.documents.create(dto, user);
  }

  @Get()
  @ApiOperation({ summary: 'Listar documentos (paginado cursor). Filtros: status, ownerId' })
  @ApiQuery({ name: 'status', required: false, enum: FleetDocumentStatus })
  @ApiQuery({ name: 'ownerId', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  list(
    @Query('status') status?: FleetDocumentStatus,
    @Query('ownerId') ownerId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<Page<FleetDocument>> {
    return this.documents.list({
      status,
      ownerId,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @UseGuards(RolesGuard)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post(':id/review')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revisión manual del operador: VALID o REJECTED (RBAC). BR-I04' })
  review(
    @Param('id') id: string,
    @Body() dto: ReviewDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<FleetDocument> {
    return this.documents.review(id, dto.decision, user.userId, dto.reason);
  }
}
