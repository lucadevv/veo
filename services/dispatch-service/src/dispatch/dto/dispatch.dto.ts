import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude } from 'class-validator';

/** Query de cotización de surge: coordenadas del origen. */
export class SurgeQueryDto {
  @ApiProperty({ example: -12.0464, description: 'Latitud del origen' })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -77.0428, description: 'Longitud del origen' })
  @Type(() => Number)
  @IsLongitude()
  lon!: number;
}

export class SurgeResponseDto {
  @ApiProperty({ example: 1.5, description: 'Multiplier de tarifa (1.0 = sin recargo)' })
  multiplier!: number;

  @ApiProperty({ nullable: true, example: 'b2c1...' })
  zoneId!: string | null;

  @ApiProperty({ nullable: true, example: 'Miraflores Centro' })
  zoneName!: string | null;

  @ApiProperty({ example: true, description: 'true si el recargo está activo (umbral superado)' })
  active!: boolean;

  @ApiProperty({ example: 42 })
  demand!: number;

  @ApiProperty({ example: 8 })
  supply!: number;

  @ApiProperty({ example: 5.25 })
  ratio!: number;
}

export class MatchResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  tripId!: string;
  @ApiProperty()
  driverId!: string;
  @ApiProperty()
  score!: number;
  @ApiProperty()
  attempt!: number;
  @ApiProperty()
  surgeMultiplier!: number;
  @ApiProperty({ enum: ['OFFERED', 'ACCEPTED', 'REJECTED', 'TIMEOUT'] })
  outcome!: string;
  @ApiProperty()
  offeredAt!: string;
  @ApiProperty({ nullable: true })
  respondedAt!: string | null;
}
