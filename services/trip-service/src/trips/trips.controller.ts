import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, InternalIdentityGuard, type AuthenticatedUser } from '@veo/auth';
import { TripsService } from './trips.service';
import { TripQueryService } from './trip-query.service';
import { ScheduledTripService } from './scheduled-trip.service';
import { WaypointProposalService } from './waypoint-proposal.service';
import {
  AcceptTripDto,
  ArrivedTripDto,
  ArrivingTripDto,
  AssignTripDto,
  CancelScheduledDto,
  CancelTripDto,
  ChangeDestinationDto,
  CompleteTripDto,
  CreateTripDto,
  ProposeWaypointDto,
  RebidTripDto,
  RespondWaypointDto,
  ScheduledListQueryDto,
  StartTripDto,
} from './dto/trip.dto';

/**
 * API REST del viaje. Protegida por InternalIdentityGuard: las peticiones llegan del BFF,
 * que firma la identidad del usuario con HMAC (FOUNDATION §10).
 */
@ApiTags('trips')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('trips')
export class TripsController {
  constructor(
    private readonly trips: TripsService,
    private readonly query: TripQueryService,
    private readonly scheduled: ScheduledTripService,
    private readonly waypoints: WaypointProposalService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Crear y cotizar un viaje (→ REQUESTED). Idempotente vía Idempotency-Key.',
  })
  create(
    @Body() dto: CreateTripDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    // ADR-018: se retiró el gate de KYC del pasajero (ya no hay `kycVerified` firmado que exigir). La
    // verificación de identidad pasó de muro pre-viaje a badge de confianza OPCIONAL; el viaje se crea
    // sin gate de KYC (el piso de seguridad es teléfono verificado + conductor verificado + cámara/pánico).
    return this.trips.createTrip(dto, idempotencyKey);
  }

  // NOTA: la ruta literal `/trips/scheduled` se declara ANTES de `/trips/:id` para que no la capture
  // el parámetro `:id`.
  @Get('scheduled')
  @ApiOperation({
    summary: 'Listar los viajes PROGRAMADOS de un pasajero (Ola 2B, estado SCHEDULED)',
  })
  listScheduled(@Query() query: ScheduledListQueryDto) {
    return this.query.listScheduled(query.passengerId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener un viaje por id' })
  get(@Param('id') id: string) {
    return this.query.getTrip(id);
  }

  @Get(':id/state')
  @ApiOperation({ summary: 'Obtener solo el estado del viaje (BR-T02)' })
  state(@Param('id') id: string) {
    return this.query.getTripState(id);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @ApiOperation({ summary: 'Asignar conductor/vehículo (→ ASSIGNED)' })
  assign(@Param('id') id: string, @Body() dto: AssignTripDto) {
    return this.trips.assignDriver(id, dto);
  }

  // Anti-IDOR (transiciones del conductor): el `driverId` dueño se toma de la identidad FIRMADA
  // (`user.driverId`, que el driver-bff deriva y firma), NUNCA del cliente. Se inyecta acá sobre el dto,
  // pisando cualquier driverId del cuerpo → el check del service (`trip.driverId === dto.driverId`) compara
  // contra el id firmado. Solo el driver-bff llama estos endpoints (verificado).
  @Post(':id/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'El conductor acepta (→ ACCEPTED)' })
  accept(
    @Param('id') id: string,
    @Body() dto: AcceptTripDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.trips.acceptTrip(id, { ...dto, driverId: user.driverId });
  }

  @Post(':id/arriving')
  @HttpCode(200)
  @ApiOperation({ summary: 'El conductor va en camino (→ ARRIVING)' })
  arriving(
    @Param('id') id: string,
    @Body() dto: ArrivingTripDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.trips.arriving(id, { ...dto, driverId: user.driverId });
  }

  @Post(':id/arrived')
  @HttpCode(200)
  @ApiOperation({ summary: 'El conductor llegó al recojo (→ ARRIVED)' })
  arrived(
    @Param('id') id: string,
    @Body() dto: ArrivedTripDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.trips.arrived(id, { ...dto, driverId: user.driverId });
  }

  @Post(':id/start')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Iniciar el viaje; valida código modo niño si aplica (→ IN_PROGRESS, BR-T07)',
  })
  start(
    @Param('id') id: string,
    @Body() dto: StartTripDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.trips.start(id, { ...dto, driverId: user.driverId });
  }

  @Post(':id/complete')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Finalizar el viaje (→ COMPLETED). EFECTIVO: cashCollected=true ⇒ el conductor cobró en mano ' +
      '(driverConfirmed); solo aplica a viajes CASH (digital lo ignora). Emite trip.completed.',
  })
  complete(
    @Param('id') id: string,
    @Body() dto: CompleteTripDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.trips.complete(id, { ...dto, driverId: user.driverId });
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancelar el viaje; calcula penalización (BR-T03)' })
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelTripDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Anti-IDOR: la rama PASAJERO usa user.userId (en el service); la rama CONDUCTOR usa el driverId
    // FIRMADO inyectado acá (pisa el del cliente). Para un pasajero, user.driverId es undefined → la rama
    // conductor no aplica de todos modos (by==='PASSENGER').
    return this.trips.cancel(id, { ...dto, driverId: user.driverId }, user);
  }

  @Post(':id/destination')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cambio de destino aprobado por el pasajero; recalcula tarifa (BR-T01)',
  })
  changeDestination(@Param('id') id: string, @Body() dto: ChangeDestinationDto) {
    return this.trips.changeDestination(id, dto);
  }

  // ───────────────────────── Lote C1 · Parada mid-trip negociada ─────────────────────────

  @Post(':id/waypoints')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'El PASAJERO propone una parada DURANTE el viaje (IN_PROGRESS): el server calcula el delta de ' +
      'tarifa + ruta nueva y crea una propuesta con TTL. El conductor la acepta/rechaza (Lote C1).',
  })
  proposeWaypoint(
    @Param('id') id: string,
    @Body() dto: ProposeWaypointDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Anti-IDOR: el dueño es el userId FIRMADO (siempre presente vía InternalIdentityGuard), no el del body.
    return this.waypoints.proposeWaypoint(id, { point: dto.point, passengerId: user.userId });
  }

  @Post(':id/waypoints/:proposalId/respond')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'El CONDUCTOR acepta o rechaza la parada propuesta. Si acepta: el waypoint se agrega al viaje y ' +
      'la tarifa se actualiza (delta estampado server-side) en una transacción ACID (Lote C1).',
  })
  respondWaypoint(
    @Param('id') id: string,
    @Param('proposalId') proposalId: string,
    @Body() dto: RespondWaypointDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Anti-IDOR: el driverId dueño se toma de la identidad FIRMADA (driver-bff lo deriva), no del cliente.
    return this.waypoints.respondWaypoint(id, proposalId, {
      accept: dto.accept,
      driverId: user.driverId,
    });
  }

  @Post(':id/rebid')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'RE-PUJA del pasajero: reactiva la puja de un viaje REASSIGNING/EXPIRED a un nuevo bid ' +
      '(→ REQUESTED, board fresco). Ownership server-side; idempotente. ADR 010 #4/#12 · H6.4',
  })
  rebid(
    @Param('id') id: string,
    @Body() dto: RebidTripDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Anti-IDOR: el dueño es el userId FIRMADO (siempre presente vía InternalIdentityGuard), no el del body.
    return this.trips.rebid(id, user.userId, dto.bidCents);
  }

  @Delete(':id/schedule')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancelar un viaje PROGRAMADO antes de activarse (Ola 2B; sin penalidad)',
  })
  cancelSchedule(
    @Param('id') id: string,
    @Body() dto: CancelScheduledDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Anti-IDOR: el dueño es el userId FIRMADO (siempre presente vía InternalIdentityGuard), no el del body.
    return this.scheduled.cancelScheduledTrip(id, user.userId);
  }
}
