/**
 * Carpooling del CONDUCTOR (ADR-014) · driver-bff. Expone al conductor las 7 operaciones del marketplace
 * PROGRAMADO, cada una PROXY a booking-service (driver-rail) con el driverId derivado server-side (anti-IDOR):
 *
 *   POST   /carpool/trips                 → publicar una oferta (Idempotency-Key opcional)
 *   GET    /carpool/trips                 → listar MIS ofertas (keyset ?limit=&cursor=)
 *   PATCH  /carpool/trips/:id             → editar una oferta (solo dueño + PUBLICADO)
 *   POST   /carpool/trips/:id/cancel      → cancelar una oferta (solo dueño, pre-EN_RUTA)
 *   GET    /carpool/trips/:id/bookings    → solicitudes entrantes de un viaje PROPIO (keyset)
 *   POST   /carpool/bookings/:id/approve  → aprobar una solicitud (dispara CHARGE)
 *   POST   /carpool/bookings/:id/reject   → rechazar una solicitud (sin cobro)
 *
 * JWT type 'driver' + rate limit (via @DriverApi()). El `driverId`/identidad los deriva/firma el service; la
 * app NUNCA los manda. El cuerpo se valida con los DTOs del borde (ValidationPipe global: whitelist+transform).
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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import type {
  BookingRequestList,
  BookingRequestView,
  PublishedTripList,
  PublishedTripView,
} from '@veo/api-client';
import { DriverApi } from '../common/driver-api.decorator';
import { CarpoolService } from './carpool.service';
import { PublishTripDto, UpdateTripDto, CarpoolPageQueryDto } from './dto/carpool.dto';

@ApiTags('carpool')
@DriverApi()
@Controller('carpool')
export class CarpoolController {
  constructor(private readonly carpool: CarpoolService) {}

  @Post('trips')
  @HttpCode(201)
  @ApiOperation({ summary: 'Publicar un viaje de carpooling (oferta) · idempotente vía Idempotency-Key' })
  publish(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PublishTripDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<PublishedTripView> {
    return this.carpool.publish(user, dto, idempotencyKey);
  }

  @Get('trips')
  @ApiOperation({ summary: 'Listar las ofertas del conductor autenticado (keyset paginado)' })
  listMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() page: CarpoolPageQueryDto,
  ): Promise<PublishedTripList> {
    return this.carpool.listMine(user, page);
  }

  @Patch('trips/:id')
  @ApiOperation({ summary: 'Editar una oferta publicada (solo el dueño, solo si PUBLICADO)' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTripDto,
  ): Promise<PublishedTripView> {
    return this.carpool.update(user, id, dto);
  }

  @Post('trips/:id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancelar una oferta publicada (solo el dueño, pre-EN_RUTA)' })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PublishedTripView> {
    return this.carpool.cancel(user, id);
  }

  @Get('trips/:id/bookings')
  @ApiOperation({ summary: 'Listar las solicitudes (reservas) entrantes de un viaje propio (keyset paginado)' })
  listTripBookings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() page: CarpoolPageQueryDto,
  ): Promise<BookingRequestList> {
    return this.carpool.listTripBookings(user, id, page);
  }

  @Post('bookings/:id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Aprobar una solicitud (PENDIENTE_APROBACION → APROBADO → dispara CHARGE)' })
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<BookingRequestView> {
    return this.carpool.approve(user, id);
  }

  @Post('bookings/:id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rechazar una solicitud (PENDIENTE_APROBACION → RECHAZADO, sin cobro)' })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<BookingRequestView> {
    return this.carpool.reject(user, id);
  }
}
