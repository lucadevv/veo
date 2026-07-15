/**
 * Endpoint INTERNO mínimo para el GUARD del HARD purge de conductores (admin-bff): "¿este conductor
 * tiene historial operativo (viajes)?". El admin-bff lo consulta ANTES de purgar — si el conductor
 * operó alguna vez, el purge se rechaza (409) y debe usarse el flujo de olvido BR-S06.
 *
 * Montado bajo el prefijo global `api/v1` → ruta efectiva `/api/v1/internal/drivers/:driverId/trip-count`.
 * Protegido por InternalIdentityGuard (firma HMAC del BFF, FOUNDATION §10), mismo patrón que el
 * controller interno de analytics. `driverId` aquí = `Trip.driverId` (el id de perfil Driver de identity,
 * el MISMO que el admin-bff usa como :id de la ruta de ops).
 */
import { Controller, Delete, Get, HttpCode, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalIdentityGuard, RolesGuard, Roles } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { DriverTripsRepository } from './driver-trips.repository';
import { DriverTripsService, type DriverTripsPurgeView } from './driver-trips.service';

/** Resumen del historial operativo de un conductor para el guard del purge. */
export interface DriverTripCountView {
  driverId: string;
  tripCount: number;
  hasTrips: boolean;
}

@ApiTags('drivers')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('internal/drivers')
export class DriverTripsController {
  constructor(
    private readonly repo: DriverTripsRepository,
    private readonly driverTrips: DriverTripsService,
  ) {}

  @Get(':driverId/trip-count')
  @ApiOperation({
    summary:
      'Historial operativo del conductor: cantidad de viajes (guard del HARD purge en admin-bff)',
  })
  async tripCount(@Param('driverId') driverId: string): Promise<DriverTripCountView> {
    // count del lado del motor (sin cargar filas). CUALQUIER viaje en CUALQUIER estado cuenta como
    // historial operativo: un conductor que alguna vez tuvo un trip NO es "no-operado" y no se purga.
    const tripCount = await this.repo.countTripsByDriver(driverId);
    return { driverId, tripCount, hasTrips: tripCount > 0 };
  }

  /**
   * HARD purge de TODOS los viajes del conductor (+ eventos + propuestas de parada), en UNA transacción.
   * Lo invoca el admin-bff SOLO en DEV durante el purge en cascada (en PROD el guard de historial corta
   * antes y deriva al flujo de olvido BR-S06). `:driverId` = id de PERFIL Driver de identity (= Trip.driverId).
   *
   * GUARDS (orden importa): InternalIdentityGuard (clase) verifica la firma HMAC del admin-bff y puebla
   * `req.user` con sus roles; RolesGuard (método) valida SUPERADMIN sobre ese usuario. Espeja fleet/media.
   */
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  @Delete(':driverId/trips')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'HARD purge de los viajes del conductor (+ eventos + propuestas). DEV-only. SUPERADMIN.',
  })
  purgeTrips(@Param('driverId') driverId: string): Promise<DriverTripsPurgeView> {
    return this.driverTrips.purgeForDriver(driverId);
  }
}
