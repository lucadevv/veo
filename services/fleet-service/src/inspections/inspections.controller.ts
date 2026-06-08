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
  @ApiOperation({ summary: 'Listar inspecciones de un vehículo' })
  @ApiQuery({ name: 'vehicleId', required: true })
  listByVehicle(@Query('vehicleId') vehicleId: string): Promise<Inspection[]> {
    return this.inspections.listByVehicle(vehicleId);
  }
}
