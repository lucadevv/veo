/**
 * Calificaciones (lado conductor). Espejo del `RatingsService` del public-bff:
 *  - Crear es COMANDO (REST interno firmado con HMAC): el rating-service deriva el `raterId` de la
 *    identidad (anti-IDOR) y valida contra trip-service que el conductor participó y que el sujeto es su
 *    contraparte (el pasajero). El BFF NUNCA acepta un raterId del cliente.
 *  - MI calificación de un viaje es LECTURA (GET /ratings?tripId) filtrada server-side por ese rater.
 *
 * IDENTIDAD DEL RATER (fix del 403 "No participaste de este viaje"): `trip.driverId` es el id del
 * PERFIL de conductor (identity.drivers), NO el userId del JWT. Este BFF resuelve el `driverId`
 * (GetDriverByUser, mismo patrón anti-IDOR que las transiciones del viaje) y lo FIRMA en la identidad
 * interna; el rating-service usa ese `driverId` como raterId para el gate de participación y el filtro
 * de lectura. Sin esto, el conductor JAMÁS podía calificar (userId ≠ trip.driverId, visto en vivo).
 */
import { Injectable } from '@nestjs/common';
import { DownstreamError } from '@veo/rpc';
import { NotFoundError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import { RestGateway } from '../infra/rest.gateway';
import { GrpcGateway } from '../infra/grpc.gateway';
import type { DriverReply } from '../common/grpc-replies';
import type { CreateRatingDto, MyRatingView, RatingView } from './dto/rating.dto';

@Injectable()
export class RatingsService {
  constructor(
    private readonly rest: RestGateway,
    private readonly grpc: GrpcGateway,
  ) {}

  /** POST /ratings al rating-service. La identidad firmada (CON driverId) viaja aparte; el `raterId` se deriva de ella. */
  async create(user: AuthenticatedUser, dto: CreateRatingDto): Promise<RatingView> {
    const identity = await this.withDriverId(user);
    return this.rating().post<RatingView>('/ratings', { identity, body: dto });
  }

  /**
   * MI calificación de un viaje (la que ESTE conductor le dio al pasajero), o `null` si aún no calificó.
   * El rating-service devuelve 404 cuando no existe; acá lo colapsamos a `null` para que el contrato de la
   * app sea `{...} | null` (distingue "no calificado" de un error real sin parsear el cuerpo del 404).
   * Cualquier OTRO error (5xx, timeout, etc.) se PROPAGA: no se enmascara como "sin rating".
   */
  async getMyRatingForTrip(user: AuthenticatedUser, tripId: string): Promise<MyRatingView | null> {
    try {
      const identity = await this.withDriverId(user);
      const r = await this.rating().get<RatingView>('/ratings', {
        identity,
        query: { tripId },
      });
      return { stars: r.stars, comment: r.comment, createdAt: r.createdAt };
    } catch (err) {
      if (err instanceof DownstreamError && err.status === 404) return null;
      throw err;
    }
  }

  /** Identidad con el `driverId` RESUELTO server-side (userId→driver vía identity; anti-IDOR). */
  private async withDriverId(user: AuthenticatedUser): Promise<AuthenticatedUser> {
    const driver = await this.grpc.call<DriverReply>(
      'identity',
      'GetDriverByUser',
      { id: user.userId },
      user,
    );
    if (!driver.found) throw new NotFoundError('Conductor no encontrado');
    return { ...user, driverId: driver.id };
  }

  private rating() {
    return this.rest.client('rating');
  }
}
