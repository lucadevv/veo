import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, IsUUID, ValidateNested } from 'class-validator';
import { GeoPointDto } from '../../trips/dto/trip.dto';

/**
 * Disparo de pánico (BR-S04). La firma HMAC la genera el dispositivo del cliente con su secreto;
 * el BFF la reenvía sin tocarla. dedupKey hace el doble-submit idempotente.
 */
export class TriggerPanicDto {
  @ApiProperty({ format: 'uuid', description: 'Viaje en curso asociado a la alerta' })
  @IsUUID()
  tripId!: string;

  @ApiProperty({ format: 'uuid', description: 'Clave de idempotencia (UUIDv7) del cliente' })
  @IsUUID()
  dedupKey!: string;

  @ApiProperty({ type: GeoPointDto })
  @ValidateNested()
  @Type(() => GeoPointDto)
  geo!: GeoPointDto;

  @ApiProperty({ description: 'Firma HMAC-SHA256 (hex) del mensaje canónico de pánico (BR-S04)' })
  @IsString()
  signature!: string;
}

export interface PanicTriggerResult {
  panicId: string;
  status: string;
  deduplicated: boolean;
  triggeredAt: string;
  evidenceS3Keys: string[];
}

export interface PanicView {
  id: string;
  tripId: string;
  passengerId: string;
  status: string;
  geo: { lat: number; lon: number };
  triggeredAt: string;
  acknowledgedAt: string | null;
}
