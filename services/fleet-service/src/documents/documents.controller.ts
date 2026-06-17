import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import {
  InternalIdentityGuard,
  RolesGuard,
  Roles,
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

  @Post()
  @ApiOperation({ summary: 'Subir un documento (queda PENDING_REVIEW). BR-I04' })
  create(@Body() dto: CreateDocumentDto): Promise<FleetDocument> {
    return this.documents.create(dto);
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
    return this.documents.review(id, dto.decision, user.userId);
  }
}
