/**
 * DriverVehiclesController — alta y consulta self-service del vehículo del conductor (onboarding).
 * Auth: InternalIdentityGuard (identidad propagada por el driver-bff). El driverId se toma del
 * usuario autenticado (@CurrentUser), nunca del body, y se exige que sea un conductor.
 */
import { Body, Controller, Get, HttpCode, Patch, Post, Res, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { InternalIdentityGuard, CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { ForbiddenError } from '@veo/utils';
import { VehiclesService } from './vehicles.service';
import { RegisterDriverVehicleDto, SelectVehicleDto, type DriverVehicleResponse } from './dto/vehicle.dto';

/** Mínimo del response para fijar el status (204) sin acoplar a express/fastify. */
interface HttpResponseLike {
  status(code: number): unknown;
}

@ApiTags('driver-vehicles')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('drivers/vehicles')
export class DriverVehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'El conductor registra su vehículo (queda pendiente de verificación)' })
  register(
    @Body() dto: RegisterDriverVehicleDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DriverVehicleResponse> {
    return this.vehicles.registerForDriver(this.driverId(user), dto);
  }

  @Get()
  @ApiOperation({ summary: 'Lista los vehículos del conductor autenticado (rehidratación), con isActive' })
  listMine(@CurrentUser() user: AuthenticatedUser): Promise<DriverVehicleResponse[]> {
    return this.vehicles.listForDriver(this.driverId(user));
  }

  @Get('active')
  @ApiOperation({
    summary: 'Vehículo ACTIVO (operado) del conductor; 200 + vehículo o 204 si no tiene ninguno operable',
  })
  async active(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<DriverVehicleResponse | undefined> {
    const vehicle = await this.vehicles.getActiveVehicle(this.driverId(user));
    if (!vehicle) {
      res.status(204);
      return undefined;
    }
    return vehicle;
  }

  @Patch('active')
  @ApiOperation({ summary: 'Selecciona el vehículo ACTIVO del conductor (server-authoritative)' })
  selectActive(
    @Body() dto: SelectVehicleDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DriverVehicleResponse> {
    return this.vehicles.setActiveVehicle(this.driverId(user), dto.vehicleId);
  }

  /**
   * Garantiza que la identidad sea de un conductor antes de operar sobre su flota y devuelve el id que
   * fleet persiste como `driver_id`.
   * NOTA: ese id es el **User.id** de identity (`user.userId` del token propagado), NO el id de perfil
   * `Driver` de identity. fleet no conoce identity y guarda el sujeto de la identidad tal cual.
   */
  private driverId(user: AuthenticatedUser): string {
    if (user.type !== 'driver') {
      throw new ForbiddenError('Solo un conductor puede gestionar su propio vehículo', { type: user.type });
    }
    return user.userId;
  }
}
