/**
 * Query del GET /internal/pricing/resolve — lat/lon del origen para el quote (M4). En el MVP la zona es
 * GLOBAL (lat/lon se ACEPTAN pero no cambian el resultado); el contrato ya transporta la ubicación para
 * que Tier 2 (per-zona) sea no-breaking.
 */
import { Type } from 'class-transformer';
import { IsISO8601, IsLatitude, IsLongitude, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ResolveQueryDto {
  @ApiProperty({ description: 'Latitud del origen' })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty({ description: 'Longitud del origen' })
  @Type(() => Number)
  @IsLongitude()
  lon!: number;

  /**
   * S2 (ADR 011) — instante para el que resolver el modo (ISO-8601). Default `now` si se omite. El quote
   * de una RESERVA (scheduledFor futuro) lo pasa con la hora de RECOJO → el preview muestra la política de
   * la HORA del recojo, no la del momento en que se pide. Sin él, un quote a las 14:00 para un recojo a las
   * 22:00 mostraría el modo de las 14:00. Solo afecta la LECTURA: el modo se congela recién en createTrip.
   */
  @ApiPropertyOptional({
    description:
      'Instante a resolver (ISO-8601). Default ahora. El quote de una reserva pasa la hora de recojo.',
    example: '2026-06-01T22:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  at?: string;
}
