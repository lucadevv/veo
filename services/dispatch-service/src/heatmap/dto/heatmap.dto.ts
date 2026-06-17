import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude, IsOptional, IsPositive, Max } from 'class-validator';

/** Query del mapa de calor: punto del conductor + radio opcional (metros). */
export class HeatmapQueryDto {
  @ApiProperty({ example: -12.0464, description: 'Latitud del conductor' })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -77.0428, description: 'Longitud del conductor' })
  @Type(() => Number)
  @IsLongitude()
  lng!: number;

  @ApiPropertyOptional({
    example: 2500,
    description: 'Radio de búsqueda en metros (default 2500, máx 10000)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsPositive()
  @Max(10_000)
  radius?: number;
}

export class HeatmapCellDto {
  @ApiProperty({ example: '89283082837ffff', description: 'Índice de celda H3 (res 9)' })
  h3!: string;

  @ApiProperty({ example: -12.0464 })
  centroidLat!: number;

  @ApiProperty({ example: -77.0428 })
  centroidLng!: number;

  @ApiProperty({
    example: 0.75,
    description: 'Intensidad normalizada 0..1 (1 = celda más caliente)',
  })
  intensity!: number;
}

export class HeatmapResponseDto {
  @ApiProperty({ type: [HeatmapCellDto] })
  cells!: HeatmapCellDto[];

  @ApiProperty({ example: '2026-05-30T19:00:00.000Z' })
  generatedAt!: string;
}
