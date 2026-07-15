/**
 * Rutas del carpooling del PASAJERO (`/api/v1/carpool/*` · ADR-014). Prefijo espejo del driver-bff
 * (`/carpool/*`) para que ambos rieles hablen el mismo idioma de paths. La sesión del pasajero es la
 * normal del BFF (JWT); la identidad se propaga FIRMADA al downstream (public-rail).
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import type {
  CarpoolBookingView,
  CarpoolPopularRoutes,
  CarpoolSearchPage,
  CarpoolTripDetail,
} from '@veo/api-client';
import { CarpoolService } from './carpool.service';
import {
  BrowseCarpoolTripsDto,
  CreateCarpoolBookingDto,
  SearchCarpoolTripsDto,
} from './dto/carpool.dto';

@ApiTags('carpool')
@ApiBearerAuth()
@Controller('carpool')
export class CarpoolController {
  constructor(private readonly carpool: CarpoolService) {}

  // GET /trips/search ANTES de GET /trips/:id (ruta estática precede a la paramétrica).
  @Get('trips/search')
  @ApiOperation({
    summary: 'Buscar viajes publicados por ruta (origen→destino) + fecha + asientos (keyset)',
  })
  search(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: SearchCarpoolTripsDto,
  ): Promise<CarpoolSearchPage> {
    return this.carpool.search(user, dto);
  }

  // GET /trips/browse ANTES de GET /trips/:id (ruta estática precede a la paramétrica).
  @Get('trips/browse')
  @ApiOperation({
    summary:
      'FEED del marketplace de carpool: todos los viajes publicados futuros, filtrable por región (keyset)',
  })
  browse(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: BrowseCarpoolTripsDto,
  ): Promise<CarpoolSearchPage> {
    return this.carpool.browse(user, dto);
  }

  // GET /trips/popular-routes ANTES de GET /trips/:id (ruta estática precede a la paramétrica).
  @Get('trips/popular-routes')
  @ApiOperation({
    summary:
      'Rutas populares del marketplace: top-N de pares región→región con viajes ofertables (count + precio desde)',
  })
  popularRoutes(@CurrentUser() user: AuthenticatedUser): Promise<CarpoolPopularRoutes> {
    return this.carpool.popularRoutes(user);
  }

  @Get('trips/:id')
  @ApiOperation({
    summary: 'Detalle enriquecido de un viaje publicado (conductor + vehículo públicos)',
  })
  getDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CarpoolTripDetail> {
    return this.carpool.getDetail(user, id);
  }

  @Post('bookings')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Solicitar la reserva de asiento(s) en un viaje publicado. Idempotente vía Idempotency-Key.',
  })
  reserve(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCarpoolBookingDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CarpoolBookingView> {
    return this.carpool.reserve(user, dto, idempotencyKey);
  }

  @Get('bookings/:id')
  @ApiOperation({ summary: 'Ver MI reserva por id (seguimiento de la aprobación del conductor)' })
  getBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CarpoolBookingView> {
    return this.carpool.getBooking(user, id);
  }

  @Post('bookings/:id/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Cancelar MI solicitud aún pendiente (PENDIENTE_APROBACION → CANCELADO, sin cobro). Ajena/inexistente → 404; ya resuelta → 409.',
  })
  cancelBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CarpoolBookingView> {
    return this.carpool.cancelBooking(user, id);
  }
}
