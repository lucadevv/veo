import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { InternalIdentityGuard, RolesGuard, Roles } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { DocumentsService } from '../documents/documents.service';
import type { FleetDocument } from '../generated/prisma';
import type { Page } from '../infra/pagination';

@ApiTags('fleet')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard, RolesGuard)
@Controller('fleet')
export class ExpirationsController {
  constructor(private readonly documents: DocumentsService) {}

  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Get('expirations')
  @ApiOperation({
    summary:
      'Cola de documentos por vencer / vencidos (BR-I04). Paginada por cursor compuesto (expiresAt, id); ' +
      'página default 25, máx 100. Devuelve { items, nextCursor }.',
  })
  @ApiQuery({ name: 'days', required: false, description: 'Ventana en días desde hoy (opcional)' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Cursor de la página previa (nextCursor)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Tamaño de página (1..100, default 25)' })
  listExpirations(
    @Query('days') days?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<Page<FleetDocument>> {
    const withinDays = days !== undefined ? Number.parseInt(days, 10) : undefined;
    return this.documents.listExpirations({
      withinDays: withinDays !== undefined && Number.isFinite(withinDays) ? withinDays : undefined,
      cursor,
      limit: limit !== undefined ? Number(limit) : undefined,
    });
  }
}
