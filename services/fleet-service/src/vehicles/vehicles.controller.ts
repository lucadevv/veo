import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { InternalIdentityGuard, RolesGuard, Roles } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { VehiclesService } from './vehicles.service';
import { CreateVehicleDto } from './dto/vehicle.dto';
import { VehicleDocStatus, type Vehicle } from '../generated/prisma';
import type { Page } from '../infra/pagination';

@ApiTags('vehicles')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @UseGuards(RolesGuard)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post()
  @ApiOperation({ summary: 'Registrar un vehículo (BR-D04: año >= 2017, placa válida)' })
  create(@Body() dto: CreateVehicleDto): Promise<Vehicle> {
    return this.vehicles.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar la flota (paginado cursor). Filtros: docStatus, active' })
  @ApiQuery({ name: 'docStatus', required: false, enum: VehicleDocStatus })
  @ApiQuery({ name: 'active', required: false, type: Boolean })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  list(
    @Query('docStatus') docStatus?: VehicleDocStatus,
    @Query('active') active?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<Page<Vehicle>> {
    return this.vehicles.list({
      docStatus,
      active: active === undefined ? undefined : active === 'true',
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener un vehículo por id' })
  getById(@Param('id') id: string): Promise<Vehicle> {
    return this.vehicles.getById(id);
  }
}
