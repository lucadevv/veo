/**
 * Carpooling del CONDUCTOR (ADR-014). Proxya a booking-service (REST interno firmado) las 7 operaciones del
 * conductor: publicar / listar / editar / cancelar una oferta (PublishedTrip) y ver / aprobar / rechazar las
 * solicitudes entrantes (Booking). El driver-bff NO reimplementa la lógica: la valida en el borde y delega.
 *
 * ANTI-IDOR (mismo patrón que earnings/trips): el `driverId` NUNCA viene del cliente. Se DERIVA del perfil
 * (identity `GetDriverByUser` sobre el userId del JWT) y se adjunta a la identidad propagada; el RestGateway la
 * firma (HMAC + riel driver) y booking-service la verifica (`InternalIdentityGuard` + `@Audiences(DRIVER_RAIL)`)
 * y toma el `driverId` de ahí (server-truth), no del body. La ownership de la oferta/solicitud la sella el
 * service downstream contra ese driverId (viaje/solicitud ajenos → 404).
 */
import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import type {
  BookingRequestList,
  BookingRequestView,
  PublishedTripList,
  PublishedTripView,
} from '@veo/api-client';
import { GrpcGateway } from '../infra/grpc.gateway';
import { RestGateway } from '../infra/rest.gateway';
import type { DriverReply } from '../common/grpc-replies';
import type { PublishTripDto, UpdateTripDto, CarpoolPageQueryDto } from './dto/carpool.dto';

@Injectable()
export class CarpoolService {
  constructor(
    private readonly grpc: GrpcGateway,
    private readonly rest: RestGateway,
  ) {}

  /** POST /published-trips — publica la oferta. `Idempotency-Key` (opcional) deduplica el submit. */
  async publish(
    identity: AuthenticatedUser,
    dto: PublishTripDto,
    idempotencyKey?: string,
  ): Promise<PublishedTripView> {
    const { identity: signed } = await this.resolveDriver(identity);
    return this.booking().post<PublishedTripView>('/published-trips', {
      identity: signed,
      body: dto,
      idempotencyKey,
    });
  }

  /** GET /published-trips/mine — lista las ofertas del conductor (keyset, scoped server-truth). */
  async listMine(
    identity: AuthenticatedUser,
    page: CarpoolPageQueryDto,
  ): Promise<PublishedTripList> {
    const { identity: signed } = await this.resolveDriver(identity);
    return this.booking().get<PublishedTripList>('/published-trips/mine', {
      identity: signed,
      query: { limit: page.limit, cursor: page.cursor },
    });
  }

  /** PATCH /published-trips/:id — edita la oferta (solo dueño + PUBLICADO; lo sella el service). */
  async update(
    identity: AuthenticatedUser,
    id: string,
    dto: UpdateTripDto,
  ): Promise<PublishedTripView> {
    const { identity: signed } = await this.resolveDriver(identity);
    return this.booking().patch<PublishedTripView>(`/published-trips/${id}`, {
      identity: signed,
      body: dto,
    });
  }

  /** POST /published-trips/:id/cancel — cancela la oferta (solo dueño, pre-EN_RUTA). */
  async cancel(identity: AuthenticatedUser, id: string): Promise<PublishedTripView> {
    const { identity: signed } = await this.resolveDriver(identity);
    return this.booking().post<PublishedTripView>(`/published-trips/${id}/cancel`, {
      identity: signed,
    });
  }

  /** GET /published-trips/:id/bookings — solicitudes entrantes de un viaje PROPIO (keyset). */
  async listTripBookings(
    identity: AuthenticatedUser,
    id: string,
    page: CarpoolPageQueryDto,
  ): Promise<BookingRequestList> {
    const { identity: signed } = await this.resolveDriver(identity);
    return this.booking().get<BookingRequestList>(`/published-trips/${id}/bookings`, {
      identity: signed,
      query: { limit: page.limit, cursor: page.cursor },
    });
  }

  /** POST /bookings/:id/approve — aprueba la solicitud (dispara CHARGE → COBRO_PENDIENTE). */
  async approve(identity: AuthenticatedUser, id: string): Promise<BookingRequestView> {
    const { identity: signed } = await this.resolveDriver(identity);
    return this.booking().post<BookingRequestView>(`/bookings/${id}/approve`, {
      identity: signed,
    });
  }

  /** POST /bookings/:id/reject — rechaza la solicitud (sin cobro). */
  async reject(identity: AuthenticatedUser, id: string): Promise<BookingRequestView> {
    const { identity: signed } = await this.resolveDriver(identity);
    return this.booking().post<BookingRequestView>(`/bookings/${id}/reject`, {
      identity: signed,
    });
  }

  private booking() {
    return this.rest.client('booking');
  }

  /**
   * Resuelve el driverId del usuario autenticado (identity `GetDriverByUser`) y lo adjunta a la identidad
   * propagada, para que el RestGateway lo firme (HMAC, riel driver) y booking-service tome el `driverId`
   * server-truth sin confiar en un valor del cliente (anti-IDOR). Espeja earnings/payments/trips.
   */
  private async resolveDriver(
    identity: AuthenticatedUser,
  ): Promise<{ identity: AuthenticatedUser; driverId: string }> {
    const driver = await this.grpc.call<DriverReply>(
      'identity',
      'GetDriverByUser',
      { id: identity.userId },
      identity,
    );
    if (!driver.found)
      throw new NotFoundError('No existe un perfil de conductor para este usuario');
    return { identity: { ...identity, driverId: driver.id }, driverId: driver.id };
  }
}
