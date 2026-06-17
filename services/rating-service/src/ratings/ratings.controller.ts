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
import { CurrentUser, InternalIdentityGuard, type AuthenticatedUser } from '@veo/auth';
import { RatingsService } from './ratings.service';
import {
  AggregateResponseDto,
  CreateRatingDto,
  FindRatingsQueryDto,
  RatingResponseDto,
} from './dto/rating.dto';

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
    return this.ratings.create(user.userId, dto);
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
    const rating = await this.ratings.findByTripForRater(query.tripId, user.userId);
    if (!rating) throw new NotFoundException('No hay calificación tuya para este viaje');
    return rating;
  }

  @Get('aggregate/:subjectId')
  @ApiOperation({ summary: 'Agregado de un sujeto (promedio rolling 30d + flags)' })
  async getAggregate(@Param('subjectId') subjectId: string): Promise<AggregateResponseDto> {
    const aggregate = await this.ratings.getAggregate(subjectId);
    if (!aggregate) throw new NotFoundException('Sin agregado para este sujeto');
    return aggregate;
  }
}
