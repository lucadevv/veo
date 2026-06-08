import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude, IsOptional, IsPositive, Max } from 'class-validator';

/** GET /heatmap?lat&lng&radius → query. */
export class HeatmapQueryDto {
  @ApiProperty({ example: -12.0464 })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -77.0428 })
  @Type(() => Number)
  @IsLongitude()
  lng!: number;

  @ApiPropertyOptional({ example: 2500, description: 'Radio en metros (default 2500, máx 10000)' })
  @IsOptional()
  @Type(() => Number)
  @IsPositive()
  @Max(10_000)
  radius?: number;
}
