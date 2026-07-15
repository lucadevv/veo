import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentRail,
  CurrentUser,
  InternalIdentityGuard,
  type AuthenticatedUser,
  type InternalAudience,
} from '@veo/auth';
import { RatingsService } from './ratings.service';
import { scopeAggregateForRail } from './domain/moderation-scope';
import {
  AggregateResponseDto,
  CreateRatingDto,
  FindRatingsQueryDto,
  RatingResponseDto,
} from './dto/rating.dto';

/**
 * Identidad del RATER: para un CONDUCTOR, el sujeto que participa del viaje es su PERFIL de conductor
 * (`trip.driverId` = identity.drivers.id), NO su userId de sesión — el driver-bff lo resuelve
 * (GetDriverByUser) y lo FIRMA en la identidad interna (`driverId`, anti-IDOR by construction).
 * Sin esta derivación, el gate de participación rechazaba al conductor real con "No participaste de
 * este viaje" (visto en vivo) y la calificación bidireccional quedaba rota del lado conductor.
 * Pasajeros/admin no llevan `driverId` → cae a `userId`, el comportamiento de siempre.
 */
function raterIdOf(user: AuthenticatedUser): string {
  return user.type === 'driver' && user.driverId ? user.driverId : user.userId;
}

@ApiTags('ratings')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('ratings')
export class RatingsController {
  constructor(private readonly ratings: RatingsService) {}

  @Post()
  @ApiOperation({ summary: 'Crear calificación post-viaje (1-5). Un único rating por viaje.' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateRatingDto,
  ): Promise<RatingResponseDto> {
    return this.ratings.create(raterIdOf(user), dto);
  }

  @Get()
  @ApiOperation({
    summary:
      'Calificación que el rater autenticado dio en un viaje (?tripId). Filtra por el rater de la ' +
      'identidad interna firmada (anti-IDOR): el pasajero obtiene SU rating al conductor, nunca el ajeno.',
  })
  async findByTrip(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: FindRatingsQueryDto,
  ): Promise<RatingResponseDto> {
    const rating = await this.ratings.findByTripForRater(query.tripId, raterIdOf(user));
    if (!rating) throw new NotFoundException('No hay calificación tuya para este viaje');
    return rating;
  }

  @Get('aggregate/:subjectId')
  @ApiOperation({
    summary:
      'Agregado de un sujeto (promedio rolling 30d). La MODERACIÓN (flagged/flagReason) se acota por RIEL: ' +
      'solo driver-rail (el propio conductor) y admin-rail la ven; public/service-rail la reciben zeroeada ' +
      '(anti-IDOR · espejo REST del gRPC GetAggregate, mismo helper scopeAggregateForRail).',
  })
  async getAggregate(
    @Param('subjectId') subjectId: string,
    @CurrentRail() rail: InternalAudience | undefined,
  ): Promise<AggregateResponseDto> {
    const aggregate = await this.ratings.getAggregate(subjectId);
    if (!aggregate) throw new NotFoundException('Sin agregado para este sujeto');
    // SCOPING DE MODERACIÓN POR RIEL (anti-IDOR): MISMO punto de decisión que el gRPC. El riel viaja firmado
    // en la identidad interna (InternalIdentityGuard lo adjunta a req.user.aud); un caller public-rail recibe
    // flagged=false/flagReason=null aunque el HMAC sea válido. Cierra el gemelo REST del IDOR de moderación.
    return scopeAggregateForRail(aggregate, rail);
  }
}
