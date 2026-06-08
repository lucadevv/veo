import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { InternalIdentityGuard, RolesGuard, Roles } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { VehiclesService } from './vehicles.service';
import { CreateVehicleDto } from './dto/vehicle.dto';
import type { Vehicle } from '../generated/prisma';

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

  @Get(':id')
  @ApiOperation({ summary: 'Obtener un vehículo por id' })
  getById(@Param('id') id: string): Promise<Vehicle> {
    return this.vehicles.getById(id);
  }
}
