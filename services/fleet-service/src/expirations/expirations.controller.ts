import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { InternalIdentityGuard, RolesGuard, Roles } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { DocumentsService } from '../documents/documents.service';
import type { FleetDocument } from '../generated/prisma';

@ApiTags('fleet')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard, RolesGuard)
@Controller('fleet')
export class ExpirationsController {
  constructor(private readonly documents: DocumentsService) {}

  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Get('expirations')
  @ApiOperation({ summary: 'Documentos por vencer / vencidos (BR-I04)' })
  @ApiQuery({ name: 'days', required: false, description: 'Ventana en días desde hoy (opcional)' })
  listExpirations(@Query('days') days?: string): Promise<FleetDocument[]> {
    const withinDays = days !== undefined ? Number.parseInt(days, 10) : undefined;
    return this.documents.listExpirations(
      withinDays !== undefined && Number.isFinite(withinDays) ? withinDays : undefined,
    );
  }
}
