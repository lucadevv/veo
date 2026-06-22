/**
 * Controller del agregado PublishedTrip (ADR-014 §8 · acceso por riel server-side).
 *
 * Acceso (la UI nunca autoriza):
 *  - POST  /published-trips             → driver-rail (el CONDUCTOR publica su oferta).
 *  - GET   /published-trips/mine        → driver-rail (el CONDUCTOR lista SUS ofertas, scoped server-truth).
 *  - PATCH /published-trips/:id         → driver-rail (el CONDUCTOR edita su oferta; ownership server-truth).
 *  - POST  /published-trips/:id/cancel  → driver-rail (el CONDUCTOR cancela su oferta; ownership server-truth).
 *  - GET   /published-trips/search      → public-rail (el PASAJERO busca por ruta+fecha+asientos · geo H3).
 *  - GET   /published-trips/:id         → public-rail (el PASAJERO ve el detalle de un viaje publicado).
 *
 * El gate es server-side: InternalIdentityGuard valida la identidad firmada que el BFF propaga +
 * AudienceGuard exige el riel declarado por @Audiences (fail-closed, por handler). El `driverId` de la
 * oferta NO viene del body ni del path: se toma de la identidad firmada del conductor (server-truth,
 * anti-IDOR). En editar/cancelar/listar el ownership SIEMPRE se valida contra ese driverId server-truth.
 *
 * NOTA de scope: la BÚSQUEDA (GET /published-trips/search?ruta&fecha&asientos, §8 · F2 · índice geo H3) YA
 * está implementada acá (handler `search`, public-rail anónimo). El listado de solicitudes de una oferta
 * (GET /published-trips/:id/bookings, driver-rail · F3b) vive acá porque su path es /published-trips/...,
 * pero delega a BookingsService (el dominio de la reserva); la autorización es OWNERSHIP del PublishedTrip.
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ForbiddenError } from '@veo/utils';
import {
  Audiences,
  AudienceGuard,
  CurrentUser,
  InternalAudience,
  InternalIdentityGuard,
  type AuthenticatedUser,
} from '@veo/auth';
import { PublishedTripsService } from './published-trips.service';
import { CreatePublishedTripDto } from './dto/create-published-trip.dto';
import { UpdatePublishedTripDto } from './dto/update-published-trip.dto';
import { ListMinePageDto } from './dto/list-mine-page.dto';
import { SearchPublishedTripsDto } from './dto/search-published-trips.dto';
import { BookingsService } from '../bookings/bookings.service';
import { ListTripBookingsPageDto } from '../bookings/dto/list-trip-bookings-page.dto';

@ApiTags('published-trips')
@ApiBearerAuth()
// Riel MIXTO (driver publica / public lee): el scoping va POR MÉTODO con @Audiences. AudienceGuard a nivel
// CLASE corre para TODOS los handlers (fail-closed) — ningún método queda sin @Audiences (sería fail-open).
@UseGuards(InternalIdentityGuard, AudienceGuard)
@Controller('published-trips')
export class PublishedTripsController {
  constructor(
    private readonly trips: PublishedTripsService,
    // BookingsService: el listado de solicitudes de un viaje (F3b) es del dominio de la reserva, pero su path
    // cuelga de /published-trips/:id/bookings → se cablea acá y delega. La autorización es ownership del viaje.
    private readonly bookings: BookingsService,
  ) {}

  @Audiences(InternalAudience.DRIVER_RAIL)
  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Publicar un viaje de carpooling (BORRADOR → PUBLICADO) · driver-rail. Idempotente vía Idempotency-Key.',
  })
  publish(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePublishedTripDto,
    // Idempotency-Key (UUID por intento de submit): ancla la idempotencia de REQUEST del publish (FIX 2).
    // Reintento del mismo submit reusa la misma key → no duplica oferta+evento. La dedupKey se namespacea
    // por el driverId server-truth en el service (anti-IDOR cross-tenant). Opcional: sin él no dedupea.
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.trips.publish(this.requireDriverId(user), dto, idempotencyKey);
  }

  // GET /mine ANTES de GET /:id: ruta estática, scoped por el driverId server-truth (nunca por param).
  @Audiences(InternalAudience.DRIVER_RAIL)
  @Get('mine')
  @ApiOperation({ summary: 'Listar las ofertas del conductor (scoped server-truth, paginado) · driver-rail' })
  listMine(@CurrentUser() user: AuthenticatedUser, @Query() page: ListMinePageDto) {
    return this.trips.listMine(this.requireDriverId(user), page);
  }

  // GET /search ANTES de GET /:id (ruta estática precede a la paramétrica). public-rail ANÓNIMO: el pasajero
  // NO necesita estar logueado para buscar (no se scopea a userId). El BFF propaga una identidad public-rail
  // firmada; AudienceGuard exige el riel, InternalIdentityGuard verifica la firma — no se exige sesión real.
  @Audiences(InternalAudience.PUBLIC_RAIL)
  @Get('search')
  @ApiOperation({
    summary:
      'Buscar viajes publicados por ruta (origen→destino) + fecha + asientos (geo H3) · public-rail anónimo',
  })
  search(@Query() dto: SearchPublishedTripsDto) {
    return this.trips.search(dto);
  }

  @Audiences(InternalAudience.DRIVER_RAIL)
  @Patch(':id')
  @ApiOperation({ summary: 'Editar una oferta publicada (solo el dueño, solo si PUBLICADO) · driver-rail' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePublishedTripDto,
  ) {
    return this.trips.update(id, this.requireDriverId(user), dto);
  }

  @Audiences(InternalAudience.DRIVER_RAIL)
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancelar una oferta publicada (solo el dueño, pre-EN_RUTA) · driver-rail' })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.trips.cancel(id, this.requireDriverId(user));
  }

  // GET /:id/bookings (driver-rail) ANTES de GET /:id (public-rail): rutas con distinto largo de segmentos no
  // colisionan, pero se agrupa por claridad. Ownership del PublishedTrip (server-truth) → no-dueño = 404.
  @Audiences(InternalAudience.DRIVER_RAIL)
  @Get(':id/bookings')
  @ApiOperation({
    summary: 'Listar las solicitudes (reservas) de un viaje propio (paginado keyset) · driver-rail',
  })
  listTripBookings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() page: ListTripBookingsPageDto,
  ) {
    // driverId server-truth (no del path · anti-IDOR). El service exige ownership del PublishedTrip → 404 si ajeno.
    return this.bookings.listRequestsForTrip(id, this.requireDriverId(user), page);
  }

  @Audiences(InternalAudience.PUBLIC_RAIL)
  @Get(':id')
  @ApiOperation({
    summary: 'Ver el detalle ENRIQUECIDO de un viaje publicado (conductor + vehículo) · public-rail',
  })
  getById(@Param('id', new ParseUUIDPipe()) id: string) {
    // Detalle enriquecido (F2): viaje + conductor público (name/rating) + vehículo público (modelo/placa).
    return this.trips.getDetail(id);
  }

  /**
   * driverId = el id de conductor RESUELTO por el BFF (userId→driver) y firmado en la identidad interna
   * (HMAC, anti-IDOR · §8). server-truth: nunca del body ni de un param arbitrario. Si la identidad del
   * riel driver no porta driverId, el caller no es un conductor habilitado → 403 fail-closed.
   */
  private requireDriverId(user: AuthenticatedUser): string {
    if (!user.driverId) {
      throw new ForbiddenError('La identidad del conductor no porta driverId (no habilitado para esta acción)');
    }
    return user.driverId;
  }
}
