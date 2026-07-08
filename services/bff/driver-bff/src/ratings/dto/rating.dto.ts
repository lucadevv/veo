import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { type ActorType, ACTOR_TYPES } from '@veo/shared-types';

/**
 * Crear calificación post-viaje del CONDUCTOR (1-5). Espejo del pasajero: el `raterId` NO viaja en el
 * body — el rating-service lo DERIVA de la identidad interna firmada (anti-IDOR). El conductor califica
 * a su contraparte del viaje (el pasajero): `ratedRole` = 'PASSENGER', `ratedId` = passengerId del viaje.
 * El rating-service valida contra trip-service que el rater participó y que el `ratedId` es la contraparte.
 */
export class CreateRatingDto {
  @ApiProperty({ format: 'uuid', description: 'Viaje calificado (único por viaje)' })
  @IsUUID()
  tripId!: string;

  @ApiProperty({ format: 'uuid', description: 'Sujeto calificado (el pasajero del viaje)' })
  @IsUUID()
  ratedId!: string;

  @ApiProperty({ enum: ACTOR_TYPES, description: 'Rol del sujeto calificado (PASSENGER del lado conductor)' })
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

/** Recurso completo del rating tal como lo devuelve el rating-service por REST. */
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
 * Vista mínima de MI calificación de un viaje (la que ESTE conductor le dio al pasajero). Solo lo que la
 * app necesita para el resumen de cierre / la re-entrada ("ya calificaste"). `null` (no este objeto)
 * cuando aún no calificó — eso lo decide el service, no el DTO.
 */
export interface MyRatingView {
  stars: number;
  comment: string | null;
  createdAt: string;
}
