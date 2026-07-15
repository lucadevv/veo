/**
 * Endpoint INTERNO admin del MONITOREO + GESTIÓN de carpools (finance/carpooling).
 *
 * Montado bajo el prefijo global `api/v1` → `/api/v1/internal/booking/active-carpools[...]`. Protegido por
 * InternalIdentityGuard (firma HMAC del BFF, FOUNDATION §10): lo consume el admin-bff propagando la identidad
 * `admin` firmada. El RBAC FINO (finance:view lectura · finance:manage + step-up + audit para la CANCELACIÓN) lo
 * aplica el admin-bff; acá solo verificamos que el caller es un servicio interno legítimo (defensa en
 * profundidad). Espeja el SearchRadiusController (mismo prefijo `internal/booking`, mismo guard).
 *
 * Handlers:
 *  - GET  active-carpools           → MONITOREO (KPIs agregados + listado capado). Solo lectura.
 *  - GET  active-carpools/:id        → DETALLE de un carpool (recorrido + asientos/pasajeros + cost-share +
 *                                      conductor + vehículo). Solo lectura. Compone PublishedTrips (la oferta) +
 *                                      Bookings (los pasajeros que ocupan cupo) — MISMO patrón que el
 *                                      PublishedTripsController (delega el concern de la reserva a BookingsService).
 *  - POST active-carpools/:id/cancel → CANCELA la oferta (transición → CANCELADO por la máquina tipada, MISMO
 *                                      evento booking.cancelled que el cancel del conductor; libera cupos + avisa
 *                                      a los pasajeros aguas abajo). Acción DESTRUCTIVA — el admin-bff exige
 *                                      step-up MFA + audita. Idempotente-seguro (re-cancelar → ConflictError).
 */
import { Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  InternalIdentityGuard,
  type AuthenticatedUser,
} from '@veo/auth';
import {
  PublishedTripsService,
  type ActiveCarpoolsView,
  type AdminCarpoolDetail,
  type CancelCarpoolResult,
} from './published-trips.service';
import { BookingsService } from '../bookings/bookings.service';

/** Un pasajero (reserva viva) del detalle admin: coords de su tramo + precio acordado + estado. SIN nombre:
 *  el admin-bff lo resuelve gateado por Ley 29733 (resolvePassengerNames). Céntimos PEN. */
export interface AdminCarpoolPassenger {
  bookingId: string;
  passengerId: string;
  asientos: number;
  precioAcordadoCents: number;
  estado: string;
  pickupLat: number;
  pickupLon: number;
  dropoffLat: number;
  dropoffLon: number;
}

/** Wire del detalle admin de un carpool = la oferta (AdminCarpoolDetail) + los pasajeros vivos (bookings). */
export interface AdminCarpoolDetailResponse extends AdminCarpoolDetail {
  pasajeros: AdminCarpoolPassenger[];
}

@ApiTags('booking')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('internal/booking')
export class ActiveCarpoolsController {
  constructor(
    private readonly trips: PublishedTripsService,
    // BookingsService: los pasajeros de una oferta son del dominio de la reserva; el detalle los compone acá
    // (mismo patrón que el PublishedTripsController con GET /:id/bookings). La autorización es RBAC del admin-bff.
    private readonly bookings: BookingsService,
  ) {}

  @Get('active-carpools')
  @ApiOperation({
    summary:
      'Monitoreo de carpools ACTIVOS: KPIs agregados (activos/en ruta/ocupación/cupos) + listado capado. Panel finance/carpooling.',
  })
  activeCarpools(): Promise<ActiveCarpoolsView> {
    return this.trips.listActiveCarpools();
  }

  @Get('active-carpools/:id')
  @ApiOperation({
    summary:
      'Detalle de un carpool: recorrido (coords) + asientos/pasajeros + reparto de costo (cost-share) + conductor + vehículo.',
  })
  async carpoolDetail(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminCarpoolDetailResponse> {
    // Oferta + pasajeros en PARALELO: la oferta 404ea si no existe; los pasajeros (bookings vivos) se sirven
    // de la réplica. Ninguna lectura es crítica (monitoreo) → sin transacción.
    const [detail, seatBookings] = await Promise.all([
      this.trips.getAdminCarpoolDetail(id),
      this.bookings.listSeatBookings(id),
    ]);
    return {
      ...detail,
      pasajeros: seatBookings.map((b) => ({
        bookingId: b.id,
        passengerId: b.passengerId,
        asientos: b.asientos,
        precioAcordadoCents: b.precioAcordado,
        estado: b.estado,
        pickupLat: b.pickupLat,
        pickupLon: b.pickupLon,
        dropoffLat: b.dropoffLat,
        dropoffLon: b.dropoffLon,
      })),
    };
  }

  @Post('active-carpools/:id/cancel')
  @ApiOperation({
    summary:
      'CANCELA un carpool (→ CANCELADO por la máquina tipada; emite booking.cancelled → libera cupos + avisa a los pasajeros). Idempotente-seguro.',
  })
  cancelCarpool(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CancelCarpoolResult> {
    // El actor de la cancelación es el admin propagado (para la traza del evento); ausente → null honesto.
    return this.trips.cancelByAdmin(id, user?.userId ?? null);
  }
}
