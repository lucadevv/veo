import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/** POST /trips/:id/messages → body. Solo `body`: el BFF fija senderId/Role desde la identidad. */
export class SendMessageDto {
  @ApiProperty({ description: 'Cuerpo del mensaje' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
}

/** GET /trips/:id/messages → query. */
export class ListMessagesQueryDto {
  @ApiPropertyOptional({ description: 'Máximo de mensajes (1..100)', default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
