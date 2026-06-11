/**
 * Viajes (lado conductor). JWT de tipo 'driver'. Los GET son lecturas gRPC; los POST, comandos REST.
 */
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { DriverApi } from '../common/driver-api.decorator';
import { TripsService } from './trips.service';
import type { RespondWaypointView } from '@veo/api-client';
import {
  AcceptTripDto,
  ArrivingTripDto,
  CancelTripDto,
  CompleteTripDto,
  RespondWaypointDto,
  RouteQueryDto,
  StartTripDto,
  type TripRouteView,
  type TripStateView,
  type TripView,
} from './dto/trips.dto';

/** Mínimo del response para fijar el status (204) sin acoplar a express/fastify. */
interface HttpResponseLike {
  status(code: number): unknown;
}

@ApiTags('trips')
@DriverApi()
@Controller('trips')
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  // IMPORTANTE: `active` va ANTES de `:id` — si no, `@Get(':id')` con ParseUUIDPipe captura "active"
  // como id y responde 400. El orden de declaración define el matching.
  @Get('active')
  @ApiOperation({
    summary:
      'Viaje ACTIVO (vivo) del conductor para REHIDRATAR tras un reinicio. 200 + viaje si tiene uno en ' +
      'curso; 204 No Content si no (la app mapea 204 → null). No es error: "sin viaje activo" es normal.',
  })
  async active(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<TripView | undefined> {
    const trip = await this.trips.getActiveTrip(user);
    if (!trip) {
      res.status(204);
      return undefined;
    }
    return trip;
  }

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
  @ApiOperation({
    summary:
      'Ruta con pasos de navegación turn-by-turn del viaje (Ola 2C). Query opcional lat/lon = posición ' +
      'ACTUAL del conductor: traza la ruta desde donde está (ETA vivo + re-ruteo por desvío). Si falta ' +
      'uno de los dos, se ignoran ambos y la ruta sale del origen del viaje (degradación honesta).',
  })
  route(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: RouteQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TripRouteView> {
    // Solo usamos la posición si vienen AMBAS coordenadas (degradación honesta: una sola coordenada no
    // define un punto). class-validator ya validó el rango lat/lon; acá solo decidimos presencia.
    const from = query.lat !== undefined && query.lon !== undefined ? { lat: query.lat, lon: query.lon } : undefined;
    return this.trips.route(id, user, from);
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

  @Post(':id/waypoints/:proposalId/respond')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'El conductor ACEPTA o RECHAZA la parada propuesta por el pasajero. Si acepta, trip-service agrega ' +
      'el waypoint y actualiza la tarifa (delta estampado server-side) en una transacción ACID (Lote C2).',
  })
  respondWaypoint(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() dto: RespondWaypointDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RespondWaypointView> {
    return this.trips.respondWaypoint(id, proposalId, dto.accept, user);
  }
}
