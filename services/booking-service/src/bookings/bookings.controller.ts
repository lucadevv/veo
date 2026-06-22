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
 * NOTA de scope F0: aprobar/rechazar (POST /bookings/:id/{approve,reject}, driver-rail) es F1; cancelar
 * (DELETE /bookings/:id → Refund por tier) es F3; "ver MIS reservas" (GET /bookings/mine) es F1. F0 expone
 * solo reservar + leer por id.
 */
import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
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
// Riel PÚBLICO (el pasajero reserva/lee). @Audiences a nivel CLASE declara el riel para TODOS los
// handlers; AudienceGuard lo aplica fail-closed.
@Audiences(InternalAudience.PUBLIC_RAIL)
@UseGuards(InternalIdentityGuard, AudienceGuard)
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

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

  @Get(':id')
  @ApiOperation({ summary: 'Ver una reserva propia por id · public-rail' })
  getById(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    // passengerId = la identidad del pasajero (server-truth, no del path · anti-IDOR): solo lee SU reserva.
    return this.bookings.getById(id, user.userId);
  }
}
