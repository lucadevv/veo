import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CreateShareLinkDto {
  @ApiPropertyOptional({ description: 'Atar el enlace a un contacto de confianza concreto' })
  @IsOptional()
  @IsUUID()
  contactId?: string;

  @ApiPropertyOptional({ description: 'TTL del enlace en segundos (sobrescribe el default)' })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(86_400)
  ttlSeconds?: number;

  @ApiPropertyOptional({ description: 'Máximo de aperturas permitidas del enlace' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  maxUses?: number;
}
