/**
 * Calificaciones (lado conductor). JWT de tipo 'driver'. Crear es comando (REST); MI rating, lectura.
 * Espejo del ratings.controller del public-bff, con el guard-set del conductor (@DriverApi + globales).
 */
import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { DriverApi } from '../common/driver-api.decorator';
import { RatingsService } from './ratings.service';
import {
  CreateRatingDto,
  FindMyRatingQueryDto,
  type MyRatingView,
  type RatingView,
} from './dto/rating.dto';

/** Mínimo del response para fijar el status (204) sin acoplar a express/fastify. */
interface HttpResponseLike {
  status(code: number): unknown;
}

@ApiTags('ratings')
@DriverApi()
@Controller('ratings')
export class RatingsController {
  constructor(private readonly ratings: RatingsService) {}

  @Post()
  @ApiOperation({
    summary:
      'El conductor califica al PASAJERO de un viaje completado (1-5 + comentario opcional). El raterId ' +
      'se DERIVA del JWT del conductor (anti-IDOR): jamás viaja en el body.',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateRatingDto,
  ): Promise<RatingView> {
    return this.ratings.create(user, dto);
  }

  @Get()
  @ApiOperation({
    summary:
      'MI calificación de un viaje (?tripId): la que ESTE conductor le dio al pasajero. 200 + ' +
      '{stars,comment,createdAt} si ya calificó; 204 No Content si aún no. Filtrada por el rater ' +
      'autenticado (anti-IDOR): nunca devuelve el rating de otro ni el que el pasajero le puso.',
  })
  async myRating(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: FindMyRatingQueryDto,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<MyRatingView | undefined> {
    // 204 (no 200 con body null): el HttpClient del app mapea 204 → undefined → null sin parsear JSON.
    // "Sin calificación tuya" NO es error (no 404 hacia la app): es el estado normal de un viaje que el
    // conductor todavía no calificó (mismo patrón que /trips/active).
    const rating = await this.ratings.getMyRatingForTrip(user, query.tripId);
    if (!rating) {
      res.status(204);
      return undefined;
    }
    return rating;
  }
}
