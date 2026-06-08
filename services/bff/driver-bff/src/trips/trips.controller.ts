/**
 * Viajes (lado conductor). JWT de tipo 'driver'. Los GET son lecturas gRPC; los POST, comandos REST.
 */
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { DriverApi } from '../common/driver-api.decorator';
import { TripsService } from './trips.service';
import {
  AcceptTripDto,
  ArrivingTripDto,
  CancelTripDto,
  CompleteTripDto,
  StartTripDto,
  type TripRouteView,
  type TripStateView,
  type TripView,
} from './dto/trips.dto';

@ApiTags('trips')
@DriverApi()
@Controller('trips')
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Obtener un viaje por id (gRPC)' })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser): Promise<TripView> {
    return this.trips.getTrip(id, user);
  }

  @Get(':id/state')
  @ApiOperation({ summary: 'Obtener solo el estado del viaje (gRPC)' })
  state(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser): Promise<TripStateView> {
    return this.trips.getTripState(id, user);
  }

  @Get(':id/route')
  @ApiOperation({ summary: 'Ruta con pasos de navegación turn-by-turn del viaje (Ola 2C)' })
  route(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser): Promise<TripRouteView> {
    return this.trips.route(id, user);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'El conductor acepta (→ ACCEPTED)' })
  accept(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptTripDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown> {
    return this.trips.accept(id, dto, user);
  }

  @Post(':id/arriving')
  @HttpCode(200)
  @ApiOperation({ summary: 'El conductor va en camino (→ ARRIVING)' })
  arriving(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ArrivingTripDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown> {
    return this.trips.arriving(id, dto, user);
  }

  @Post(':id/arrived')
  @HttpCode(200)
  @ApiOperation({ summary: 'El conductor llegó al recojo (→ ARRIVED)' })
  arrived(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser): Promise<unknown> {
    return this.trips.arrived(id, user);
  }

  @Post(':id/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Iniciar el viaje; valida código modo niño si aplica (→ IN_PROGRESS)' })
  start(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartTripDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown> {
    return this.trips.start(id, dto, user);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Finalizar el viaje (→ COMPLETED). EFECTIVO: cashCollected=true ⇒ el conductor cobró en mano ' +
      '(driverConfirmed); solo aplica a viajes CASH. Ownership server-side (anti-IDOR).',
  })
  complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteTripDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown> {
    return this.trips.complete(id, dto, user);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancelar el viaje (by=DRIVER; calcula penalización BR-T03)' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelTripDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown> {
    return this.trips.cancel(id, dto, user);
  }
}
