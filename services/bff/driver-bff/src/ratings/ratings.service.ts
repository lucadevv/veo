/**
 * Calificaciones (lado conductor). Espejo del `RatingsService` del public-bff:
 *  - Crear es COMANDO (REST interno firmado con HMAC): el rating-service deriva el `raterId` de la
 *    identidad (anti-IDOR) y valida contra trip-service que el conductor participó y que el sujeto es su
 *    contraparte (el pasajero). El BFF NUNCA acepta un raterId del cliente.
 *  - MI calificación de un viaje es LECTURA (GET /ratings?tripId) filtrada server-side por ese rater.
 */
import { Injectable } from '@nestjs/common';
import { DownstreamError } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import { RestGateway } from '../infra/rest.gateway';
import type { CreateRatingDto, MyRatingView, RatingView } from './dto/rating.dto';

@Injectable()
export class RatingsService {
  constructor(private readonly rest: RestGateway) {}

  /** POST /ratings al rating-service. La identidad firmada viaja aparte; el `raterId` se deriva de ella. */
  create(user: AuthenticatedUser, dto: CreateRatingDto): Promise<RatingView> {
    return this.rating().post<RatingView>('/ratings', { identity: user, body: dto });
  }

  /**
   * MI calificación de un viaje (la que ESTE conductor le dio al pasajero), o `null` si aún no calificó.
   * El rating-service devuelve 404 cuando no existe; acá lo colapsamos a `null` para que el contrato de la
   * app sea `{...} | null` (distingue "no calificado" de un error real sin parsear el cuerpo del 404).
   * Cualquier OTRO error (5xx, timeout, etc.) se PROPAGA: no se enmascara como "sin rating".
   */
  async getMyRatingForTrip(user: AuthenticatedUser, tripId: string): Promise<MyRatingView | null> {
    try {
      const r = await this.rating().get<RatingView>('/ratings', {
        identity: user,
        query: { tripId },
      });
      return { stars: r.stars, comment: r.comment, createdAt: r.createdAt };
    } catch (err) {
      if (err instanceof DownstreamError && err.status === 404) return null;
      throw err;
    }
  }

  private rating() {
    return this.rest.client('rating');
  }
}
