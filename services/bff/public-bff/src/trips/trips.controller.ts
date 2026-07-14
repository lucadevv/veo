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
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import type { TripVideoGrant, WaypointProposalView } from '@veo/api-client';
import { TripsService } from './trips.service';
import {
  AddTipDto,
  CancelTripDto,
  ChangeDestinationDto,
  CreateTripDto,
  ProposeWaypointDto,
  RebidTripDto,
  TripHistoryQueryDto,
  TripRouteQueryDto,
  type TripResource,
  type TripRouteView,
} from './dto/trip.dto';
import { type PaymentView } from '../payments/dto/payments.dto';
import { type TripDetailView, type TripHistoryPageView, type TripStateView } from './trip-views';
import { CancelBidResponse, type OfferView, type OffersResponse } from './dto/offers.dto';

/** Tipo estructural mínimo de la respuesta HTTP (solo necesitamos fijar el status) — evita depender
 *  de los tipos de express en este paquete (mismo enfoque que el AllExceptionsFilter de observability). */
interface HttpResponseLike {
  status(code: number): unknown;
}

@ApiTags('trips')
@ApiBearerAuth()
@Controller('trips')
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @Post()
  @ApiOperation({ summary: 'Crear y cotizar un viaje (idempotente vía Idempotency-Key)' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTripDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<TripResource> {
    return this.trips.createTrip(user, dto, idempotencyKey);
  }

  @Get('scheduled')
  @ApiOperation({ summary: 'Listar los viajes PROGRAMADOS del pasajero (Ola 2B)' })
  scheduled(@CurrentUser() user: AuthenticatedUser): Promise<TripResource[]> {
    return this.trips.listScheduled(user);
  }

  @Get('history')
  @ApiOperation({
    summary:
      'Historial REAL de viajes del pasajero (servidor, no la lista local): SUS viajes ordenados por ' +
      'requestedAt DESC, paginados por cursor. Trae los estados REALES (COMPLETED/CANCELLED/EXPIRED). ' +
      'El passengerId sale del JWT (anti-IDOR). Ruta literal: declarada antes de :id.',
  })
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: TripHistoryQueryDto,
  ): Promise<TripHistoryPageView> {
    // passengerId del JWT (user), NUNCA del query: el historial solo puede ser el del pasajero autenticado.
    return this.trips.getTripHistory(user, query.cursor, query.limit);
  }

  @Get('active')
  @ApiOperation({
    summary:
      'Viaje ACTIVO (vivo) del pasajero. 200 + detalle si tiene uno; 204 No Content si no. Re-entrada al ' +
      'flujo unificado (rehidrata el sheet) + banner cross-tab. Ruta literal: declarada antes de :id.',
  })
  async active(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<TripDetailView | undefined> {
    // 204 (no 200 con body vacío): el HttpClient del app mapea 204 → undefined → null sin reventar el
    // parse JSON. "Sin viaje activo" NO es error (no 404): es un estado normal del pasajero en el home.
    const trip = await this.trips.getActiveTrip(user);
    if (!trip) {
      res.status(204);
      return undefined;
    }
    return trip;
  }

  @Get('pending-settlement')
  @ApiOperation({
    summary:
      'Cierre post-viaje PENDIENTE (re-entrada): último viaje COMPLETED del pasajero sin cerrar. 200 + ' +
      'detalle si lo hay; 204 No Content si no. Re-ofrece recibo + confirmar efectivo + rating tras un ' +
      'reload (COMPLETED es terminal y /active ya no lo devuelve). Ruta literal: declarada antes de :id.',
  })
  async pendingSettlement(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<TripDetailView | undefined> {
    // 204 (no 200 con body vacío): el HttpClient del app mapea 204 → undefined → null. "Sin cierre
    // pendiente" NO es error: es el estado normal del pasajero que ya cerró su último viaje (mismo
    // patrón que /active).
    const trip = await this.trips.getPendingSettlement(user);
    if (!trip) {
      res.status(204);
      return undefined;
    }
    return trip;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle agregado del viaje (trip + conductor + rating + vehículo)' })
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<TripDetailView> {
    return this.trips.getTripDetail(user, id);
  }

  @Get(':id/state')
  @ApiOperation({ summary: 'Estado del viaje (BR-T02)' })
  state(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<TripStateView> {
    return this.trips.getTripState(user, id);
  }

  @Get(':id/route')
  @ApiOperation({
    summary:
      'Ruta del viaje para el mapa del pasajero. Default: la CANÓNICA persistida por trip-service ' +
      '(origen→paradas→destino, con su distancia/duración; steps vacíos); si el viaje no la tiene ' +
      '(viajes viejos), fallback al cómputo por fase desde la última ubicación del conductor. ' +
      '`?leg=pickup`: el TRAMO DE ACERCAMIENTO vivo (conductor→recojo) para las fases pre-recojo; ' +
      'sin ubicación del conductor aún → ruta VACÍA honesta (el app no dibuja). ' +
      'Mismo contrato tripRoute (polyline + steps + markers).',
  })
  route(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: TripRouteQueryDto,
  ): Promise<TripRouteView> {
    return this.trips.route(user, id, query.leg);
  }

  @Get(':id/video')
  @ApiOperation({ summary: 'Token viewer LiveKit del habitáculo (solo en viaje IN_PROGRESS)' })
  video(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<TripVideoGrant> {
    return this.trips.videoGrant(user, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancelar el viaje (BR-T03)' })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CancelTripDto,
  ): Promise<TripResource> {
    return this.trips.cancel(user, id, dto);
  }

  @Post(':id/close')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Cerrar el post-viaje de un viaje COMPLETED (re-entrada): sella el cierre. Idempotente; tras esto ' +
      'el viaje deja de aparecer en /pending-settlement. NO cambia el estado del viaje (sigue COMPLETED).',
  })
  close(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<TripDetailView> {
    return this.trips.close(user, id);
  }

  @Post(':id/destination')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cambio de destino aprobado por el pasajero (BR-T01)' })
  changeDestination(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ChangeDestinationDto,
  ): Promise<TripResource> {
    return this.trips.changeDestination(user, id, dto);
  }

  @Post(':id/waypoints')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'El pasajero PROPONE una parada DURANTE el viaje (IN_PROGRESS): trip-service calcula el delta de ' +
      'tarifa + ruta nueva y crea una propuesta con TTL para que el conductor la acepte/rechace (Lote C2).',
  })
  proposeWaypoint(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ProposeWaypointDto,
  ): Promise<WaypointProposalView> {
    return this.trips.proposeWaypoint(user, id, dto.point);
  }

  @Delete(':id/schedule')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancelar un viaje PROGRAMADO antes de activarse (Ola 2B; sin penalidad)',
  })
  cancelSchedule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<TripResource> {
    return this.trips.cancelSchedule(user, id);
  }

  @Post(':id/tip')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Propina al conductor de un viaje ya cobrado (BR-P04). 100% al conductor',
  })
  tip(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AddTipDto,
  ): Promise<PaymentView> {
    return this.trips.tip(user, id, dto.tipCents);
  }

  // ── PUJA · lado pasajero (ADR 010) — todas ownership-gated por el trips.service ──

  @Get(':id/offers')
  @ApiOperation({
    summary: 'Estado del board + ofertas de SU viaje (puja): { board:{status,expiresAt}, offers }',
  })
  offers(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<OffersResponse> {
    return this.trips.listOffers(user, id);
  }

  @Post(':id/offers/:driverId/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'El pasajero elige UNA oferta de SU board → match (idempotente)' })
  acceptOffer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('driverId') driverId: string,
  ): Promise<OfferView> {
    return this.trips.acceptOffer(user, id, driverId);
  }

  @Post(':id/bid/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'El pasajero cancela la puja de SU viaje → board CANCELLED (idempotente)',
  })
  cancelBid(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<CancelBidResponse> {
    return this.trips.cancelBid(user, id);
  }

  @Post(':id/rebid')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'RE-PUJA: reactiva la puja de SU viaje (REASSIGNING/EXPIRED) a un nuevo bid → board fresco. ' +
      'Ownership server-side; idempotente. ADR 010 #4/#12 · H6.4',
  })
  rebid(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RebidTripDto,
  ): Promise<TripResource> {
    return this.trips.rebid(user, id, dto);
  }
}
