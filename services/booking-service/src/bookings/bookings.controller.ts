/**
 * Controller del agregado Booking (ADR-014 §8 · acceso por riel server-side).
 *
 * Acceso (la UI nunca autoriza):
 *  - POST /bookings       → public-rail (el PASAJERO reserva un asiento).
 *  - GET  /bookings/:id    → public-rail (el PASAJERO ve SU reserva — solo SI es el dueño).
 *
 * InternalIdentityGuard valida la identidad firmada que el BFF propaga + AudienceGuard exige el riel
 * declarado por @Audiences (fail-closed, por handler). El `passengerId` NO viene del body NI del path: se
 * toma de la identidad firmada del pasajero (server-truth, anti-IDOR), TANTO al reservar COMO al leer.
 *
 * Anti-IDOR en el READ: `GET /bookings/:id` propaga el `passengerId` del llamante al service, que devuelve
 * la reserva SOLO si es del dueño; si es ajena → 404 (no se filtra existencia). El read replica el server-
 * truth que el write (reserve) ya aplicaba.
 *
 * F3b (este lote): aprobar/rechazar una solicitud (POST /bookings/:id/{approve,reject}, driver-rail). El gate
 * server-side (dueño del PublishedTrip + driver activo) vive en el service (capa 2/3), no solo en el guard.
 *
 * NOTA de scope: cancelar (DELETE /bookings/:id → Refund por tier) es F3c; "ver MIS reservas" (GET
 * /bookings/mine) es F1. Listar las solicitudes de un viaje (GET /published-trips/:id/bookings, driver-rail)
 * vive en PublishedTripsController (su path es /published-trips/...), delegando a BookingsService.
 *
 * RIEL MIXTO: el grueso de los handlers es public-rail (el pasajero reserva/lee), pero approve/reject son
 * driver-rail. Por eso el @Audiences va POR MÉTODO (no a nivel clase): AudienceGuard a nivel clase corre para
 * TODOS los handlers (fail-closed) y cada método declara su riel — ninguno queda sin @Audiences (sería fail-open).
 */
import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
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
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';

@ApiTags('bookings')
@ApiBearerAuth()
// Riel MIXTO (pasajero reserva/lee → public; conductor aprueba/rechaza → driver): el scoping va POR MÉTODO con
// @Audiences. AudienceGuard a nivel CLASE corre para TODOS los handlers (fail-closed) — ningún método queda sin
// @Audiences (sería fail-open).
@UseGuards(InternalIdentityGuard, AudienceGuard)
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Audiences(InternalAudience.PUBLIC_RAIL)
  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Reservar un asiento en un viaje publicado · public-rail. Idempotente vía Idempotency-Key.',
  })
  reserve(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBookingDto,
    // Idempotency-Key (UUID por intento de submit): ancla la idempotencia de REQUEST. Reintento del mismo
    // submit → misma key → no duplica; submit NUEVO → key nueva → reserva nueva (sin lockout passenger×trip).
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    // passengerId = la identidad del pasajero (server-truth, no del body · anti-IDOR).
    return this.bookings.reserve(user.userId, dto, idempotencyKey);
  }

  @Audiences(InternalAudience.PUBLIC_RAIL)
  @Get(':id')
  @ApiOperation({ summary: 'Ver una reserva propia por id · public-rail' })
  getById(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    // passengerId = la identidad del pasajero (server-truth, no del path · anti-IDOR): solo lee SU reserva.
    return this.bookings.getById(id, user.userId);
  }

  // ── driver-rail: el CONDUCTOR aprueba/rechaza una solicitud sobre uno de SUS viajes (ADR-014 §8) ────────

  @Audiences(InternalAudience.DRIVER_RAIL)
  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Aprobar una solicitud (PENDIENTE_APROBACION → APROBADO → dispara CHARGE → COBRO_PENDIENTE) · driver-rail. Re-ejecutable si el charge falló.',
  })
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    // driverId = identidad firmada del conductor (server-truth, no del path · anti-IDOR). El gate de ownership
    // (dueño del PublishedTrip) + driver activo vive en el service (capa 2/3), no solo en el guard.
    return this.bookings.approve(id, this.requireDriverId(user));
  }

  @Audiences(InternalAudience.DRIVER_RAIL)
  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Rechazar una solicitud (PENDIENTE_APROBACION → RECHAZADO, sin cobro) · driver-rail',
  })
  reject(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.bookings.reject(id, this.requireDriverId(user));
  }

  /**
   * driverId = el id de conductor RESUELTO por el BFF (userId→driver) y firmado en la identidad interna
   * (HMAC, anti-IDOR · §8). server-truth: nunca del body ni de un param. Si la identidad del riel driver no
   * porta driverId, el caller no es un conductor habilitado → 403 fail-closed (espeja PublishedTripsController).
   */
  private requireDriverId(user: AuthenticatedUser): string {
    if (!user.driverId) {
      throw new ForbiddenError('La identidad del conductor no porta driverId (no habilitado para esta acción)');
    }
    return user.driverId;
  }
}
