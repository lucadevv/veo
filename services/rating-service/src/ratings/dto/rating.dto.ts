import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { SubjectRole } from '../../generated/prisma';

/** Crear una calificación post-viaje (1-5). Un único rating por viaje. */
export class CreateRatingDto {
  @ApiProperty({ format: 'uuid', description: 'Viaje calificado (único por viaje)' })
  @IsUUID()
  tripId!: string;

  @ApiProperty({ format: 'uuid', description: 'Sujeto calificado (conductor o pasajero)' })
  @IsUUID()
  ratedId!: string;

  @ApiProperty({
    enum: SubjectRole,
    description: 'Rol del sujeto calificado (define umbrales de flag)',
  })
  @IsEnum(SubjectRole)
  ratedRole!: SubjectRole;

  @ApiProperty({ minimum: 1, maximum: 5, description: 'Estrellas 1..5' })
  @IsInt()
  @Min(1)
  @Max(5)
  stars!: number;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Comentario opcional' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

/** Filtro de GET /ratings. */
export class FindRatingsQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Filtra por viaje' })
  @IsUUID()
  tripId!: string;
}

export class RatingResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty({ format: 'uuid' })
  tripId!: string;
  @ApiProperty({ format: 'uuid' })
  raterId!: string;
  @ApiProperty({ format: 'uuid' })
  ratedId!: string;
  @ApiProperty({ minimum: 1, maximum: 5 })
  stars!: number;
  @ApiPropertyOptional({ nullable: true })
  comment!: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

export class AggregateResponseDto {
  @ApiProperty({ format: 'uuid' })
  subjectId!: string;
  @ApiProperty({ enum: SubjectRole })
  role!: SubjectRole;
  @ApiProperty({ description: 'Promedio rolling de la ventana (2 decimales)' })
  rollingAvg30d!: number;
  @ApiProperty()
  count30d!: number;
  @ApiProperty()
  flagged!: boolean;
  @ApiPropertyOptional({ nullable: true })
  flagReason!: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  lastComputedAt!: Date;
}
