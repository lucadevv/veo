import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { RatingsService } from './ratings.service';
import {
  CreateRatingDto,
  FindMyRatingQueryDto,
  type AggregateView,
  type MyRatingView,
  type RatingView,
} from './dto/rating.dto';

/** Tipo estructural mínimo de la respuesta HTTP (solo fijamos el status) — evita depender de express. */
interface HttpResponseLike {
  status(code: number): unknown;
}

@ApiTags('ratings')
@ApiBearerAuth()
@Controller('ratings')
export class RatingsController {
  constructor(private readonly ratings: RatingsService) {}

  @Post()
  @ApiOperation({ summary: 'Crear calificación post-viaje (1-5)' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateRatingDto,
  ): Promise<RatingView> {
    return this.ratings.create(user, dto);
  }

  @Get()
  @ApiOperation({
    summary:
      'MI calificación de un viaje (?tripId): la que ESTE pasajero le dio al conductor. 200 + ' +
      '{stars,comment,createdAt} si ya calificó; 204 No Content si aún no. Filtrada por el rater ' +
      'autenticado (anti-IDOR): nunca devuelve el rating de otro ni el que el conductor le puso.',
  })
  async myRating(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: FindMyRatingQueryDto,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<MyRatingView | undefined> {
    // 204 (no 200 con body null): el HttpClient del app mapea 204 → undefined → null sin parsear JSON.
    // "Sin calificación tuya" NO es error (no 404 hacia la app): es el estado normal de un viaje que el
    // pasajero todavía no calificó (mismo patrón que /trips/active y /trips/pending-settlement).
    const rating = await this.ratings.getMyRatingForTrip(user, query.tripId);
    if (!rating) {
      res.status(204);
      return undefined;
    }
    return rating;
  }

  @Get('aggregate/:subjectId')
  @ApiOperation({ summary: 'Agregado de un sujeto (promedio rolling 30d + flags)' })
  getAggregate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('subjectId') subjectId: string,
  ): Promise<AggregateView> {
    return this.ratings.getAggregate(user, subjectId);
  }
}
