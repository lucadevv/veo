import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { InternalIdentityGuard, RolesGuard, Roles } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { ValidationError } from '@veo/utils';
import { VehiclesService, type VehicleListItem } from './vehicles.service';
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
  ): Promise<Page<VehicleListItem>> {
    return this.vehicles.list({
      docStatus,
      active: active === undefined ? undefined : active === 'true',
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener un vehículo por id (ENRIQUECIDO con la ficha del modelSpec, igual que la lista)' })
  getById(@Param('id') id: string): Promise<VehicleListItem> {
    return this.vehicles.getById(id);
  }

  /**
   * HARD purge de la flota de un conductor (re-registro). Recibe DOS ids porque fleet indexa cada tabla con
   * un id distinto del mismo conductor: `:driverId` (perfil Driver de identity) → documentos de operador
   * (FleetDocument ownerType DRIVER); `?userId=` (User.id de identity) → vehículos (Vehicle.driverId). El
   * admin-bff (source of truth) provee ambos. SUPERADMIN; el guard de trips vive en el admin-bff. Devuelve
   * contadores por tabla borrada (degradación/observabilidad honesta).
   */
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  @Delete('drivers/:driverId')
  @HttpCode(200)
  @ApiQuery({ name: 'userId', required: true, description: 'User.id de identity (indexa los vehículos)' })
  @ApiOperation({ summary: 'HARD purge de la flota (vehículos + documentos) de un conductor. SUPERADMIN.' })
  purgeForDriver(
    @Param('driverId') driverId: string,
    @Query('userId') userId?: string,
  ): Promise<{ documents: number; vehicles: number; vehicleDocuments: number }> {
    if (!userId) {
      throw new ValidationError('userId requerido para el purge de la flota del conductor', {
        field: 'userId',
      });
    }
    return this.vehicles.purgeForDriver({ driverId, userId });
  }
}
