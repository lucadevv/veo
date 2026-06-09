import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import {
  InternalIdentityGuard,
  RolesGuard,
  Roles,
  CurrentUser,
  type AuthenticatedUser,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { InspectionsService } from './inspections.service';
import { CreateInspectionDto } from './dto/inspection.dto';
import type { Inspection } from '../generated/prisma';
import type { Page } from '../infra/pagination';

@ApiTags('inspections')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('inspections')
export class InspectionsController {
  constructor(private readonly inspections: InspectionsService) {}

  @UseGuards(RolesGuard)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post()
  @ApiOperation({ summary: 'Registrar inspección técnica (BR-D04: trimestral)' })
  create(@Body() dto: CreateInspectionDto, @CurrentUser() user: AuthenticatedUser): Promise<Inspection> {
    return this.inspections.create(dto, user.userId);
  }

  @Get()
  @ApiOperation({ summary: 'Listar inspecciones (paginado cursor). Filtro opcional: vehicleId' })
  @ApiQuery({ name: 'vehicleId', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  list(
    @Query('vehicleId') vehicleId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<Page<Inspection>> {
    return this.inspections.list({ vehicleId, cursor, limit: limit ? Number(limit) : undefined });
  }
}
