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
import type { FleetDocument } from '../generated/prisma';

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
  @ApiOperation({ summary: 'Listar documentos de un dueño (conductor o vehículo)' })
  @ApiQuery({ name: 'ownerId', required: true })
  listByOwner(@Query('ownerId') ownerId: string): Promise<FleetDocument[]> {
    return this.documents.listByOwner(ownerId);
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
