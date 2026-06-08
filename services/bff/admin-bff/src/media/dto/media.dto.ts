/** DTOs de acceso a video (doble-auth). */
import { IsEmail, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class RequestAccessDto {
  @IsUUID()
  tripId!: string;

  @IsOptional()
  @IsUUID()
  segmentId?: string;

  @IsEmail()
  operatorEmail!: string;

  /** Motivo de la solicitud (media-service exige > 20 caracteres). */
  @IsString()
  @MinLength(21)
  reason!: string;
}

export class SegmentsQueryDto {
  @IsUUID()
  tripId!: string;
}
