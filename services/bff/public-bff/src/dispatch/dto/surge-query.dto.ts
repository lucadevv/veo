import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude } from 'class-validator';

export class SurgeQueryDto {
  @ApiProperty({ example: -12.0464 })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -77.0428 })
  @Type(() => Number)
  @IsLongitude()
  lon!: number;
}

export interface SurgeView {
  multiplier: number;
  zoneId: string;
  active: boolean;
}
