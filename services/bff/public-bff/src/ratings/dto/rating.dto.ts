import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { type ActorType, ACTOR_TYPES } from '@veo/shared-types';

/** Crear calificación post-viaje (1-5). El raterId lo deriva el downstream desde la identidad. */
export class CreateRatingDto {
  @ApiProperty({ format: 'uuid', description: 'Viaje calificado (único por viaje)' })
  @IsUUID()
  tripId!: string;

  @ApiProperty({ format: 'uuid', description: 'Sujeto calificado (conductor o pasajero)' })
  @IsUUID()
  ratedId!: string;

  @ApiProperty({ enum: ACTOR_TYPES, description: 'Rol del sujeto calificado' })
  @IsIn(ACTOR_TYPES)
  ratedRole!: ActorType;

  @ApiProperty({ minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  stars!: number;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

/** Filtro de GET /ratings (MI calificación de un viaje). El rater se deriva de la identidad, no del query. */
export class FindMyRatingQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Viaje del que se pide MI calificación' })
  @IsUUID()
  tripId!: string;
}

export interface RatingView {
  id: string;
  tripId: string;
  raterId: string;
  ratedId: string;
  stars: number;
  comment: string | null;
  createdAt: string;
}

/**
 * Vista mínima de MI calificación de un viaje (lo que el pasajero le dio al conductor). Solo lo que la
 * app necesita para el detalle / el indicador "ya calificaste" / la re-entrada del rating. `null` (no
 * este objeto) cuando aún no calificó — eso lo decide el service, no el DTO.
 */
export interface MyRatingView {
  stars: number;
  comment: string | null;
  createdAt: string;
}

export interface AggregateView {
  subjectId: string;
  role: string;
  rollingAvg30d: number;
  count30d: number;
  flagged: boolean;
  flagReason: string | null;
  lastComputedAt: string | null;
}
