import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { VideoAccessStatus } from '../../generated/prisma';

/** Body opcional al emitir un token de cámara (la identidad sale del usuario autenticado). */
export class IssueRoomTokenDto {
  @ApiPropertyOptional({ description: 'Nombre visible del participante en la room' })
  @IsOptional()
  @IsString()
  name?: string;
}

/** Solicitud de acceso a video (BR-S02). El motivo debe superar los 20 caracteres. */
export class CreateAccessRequestDto {
  @ApiProperty({ format: 'uuid', description: 'Viaje cuyo video se solicita' })
  @IsUUID()
  tripId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Segmento concreto (opcional)' })
  @IsOptional()
  @IsUUID()
  segmentId?: string;

  @ApiProperty({ description: 'Email del operador solicitante (se incrusta como watermark)' })
  @IsEmail()
  operatorEmail!: string;

  @ApiProperty({ minLength: 21, description: 'Motivo de la solicitud (> 20 caracteres)' })
  @IsString()
  @MinLength(21, { message: 'El motivo debe tener más de 20 caracteres' })
  reason!: string;
}

/** Filtro por viaje para listar segmentos. */
export class ListSegmentsQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Viaje cuyos segmentos se listan' })
  @IsUUID()
  tripId!: string;
}

/** Filtro opcional por estado para listar solicitudes de acceso (BR-S02). */
export class ListAccessRequestsQueryDto {
  @ApiPropertyOptional({
    enum: VideoAccessStatus,
    description: 'Filtra por estado de la solicitud (PENDING|APPROVED|REJECTED|EXPIRED)',
  })
  @IsOptional()
  @IsEnum(VideoAccessStatus)
  status?: VideoAccessStatus;
}

/** Body opcional al rechazar una solicitud (el motivo de rechazo se audita en el evento). */
export class RejectAccessRequestDto {
  @ApiPropertyOptional({ description: 'Motivo del rechazo (opcional)' })
  @IsOptional()
  @IsString()
  reason?: string;
}
