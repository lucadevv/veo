import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { type ActorType, ACTOR_TYPES } from '@veo/shared-types';

/** POST /chat/trips/:tripId/messages → body (lo arma el BFF: senderId/Role desde la identidad). */
export class PostMessageDto {
  @ApiProperty({ format: 'uuid', description: 'Pasajero/conductor emisor (lo fija el BFF)' })
  @IsUUID()
  senderId!: string;

  @ApiProperty({ enum: ACTOR_TYPES, description: 'Rol del emisor (espeja SenderRole de Prisma)' })
  @IsIn(ACTOR_TYPES)
  senderRole!: ActorType;

  @ApiProperty({ description: 'Cuerpo del mensaje' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;

  /**
   * Pasajero del viaje (lo conoce el BFF vía gRPC GetTrip). Se propaga al evento chat.message_sent
   * para que notification-service mande el push al PASAJERO cuando escribe el conductor, sin un join
   * cross-servicio. Opcional (compat con BFFs que aún no lo envían).
   */
  @ApiPropertyOptional({ format: 'uuid', description: 'Pasajero del viaje (lo fija el BFF)' })
  @IsOptional()
  @IsUUID()
  passengerId?: string;
}

/** GET /chat/trips/:tripId/messages → query. */
export class ListMessagesQueryDto {
  @ApiPropertyOptional({ description: 'Máximo de mensajes a devolver (1..100)', default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
