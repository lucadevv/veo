import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** GET /incentives?driverId= — query interna (el driver-bff resuelve el driverId del conductor). */
export class DriverIncentivesQueryDto {
  @ApiProperty({ description: 'Id del conductor (UUID)' })
  @IsUUID()
  driverId!: string;
}

export class DriverIncentiveDto {
  @ApiProperty()
  id!: string;
  @ApiProperty({ enum: ['META_VIAJES', 'HORA_PICO'] })
  type!: 'META_VIAJES' | 'HORA_PICO';
  @ApiProperty()
  title!: string;
  @ApiProperty()
  description!: string;
  @ApiProperty({ example: 10 })
  targetTrips!: number;
  @ApiProperty({ example: 3 })
  progressTrips!: number;
  @ApiProperty({ example: 2000, description: 'Bono en céntimos PEN (META_VIAJES)' })
  rewardCents!: number;
  @ApiProperty({ example: 12000, description: 'Multiplicador en puntos básicos de %·100 (HORA_PICO)' })
  multiplierBps!: number;
  @ApiProperty({ example: '2026-06-30T23:59:59.000Z' })
  expiresAt!: string;
  @ApiProperty({ example: false })
  completed!: boolean;
}
