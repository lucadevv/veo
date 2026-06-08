import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsLatitude, IsLongitude, IsOptional } from 'class-validator';

/**
 * Query del feed de conductores cercanos (GET /dispatch/nearby).
 * lat/lon obligatorios y validados como el resto de rutas geo (mismo pipe que surge). `vehicleType`
 * es opcional: si llega, se valida contra el enum (CAR/MOTO) y dispatch filtra; ausente = todos.
 */
export class NearbyQueryDto {
  @ApiProperty({ example: -12.0464 })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -77.0428 })
  @Type(() => Number)
  @IsLongitude()
  lon!: number;

  @ApiPropertyOptional({ example: 'CAR', enum: ['CAR', 'MOTO'] })
  @IsOptional()
  @IsIn(['CAR', 'MOTO'])
  vehicleType?: string;
}

/** Autito ANÓNIMO del mapa: SOLO posición + tipo. NUNCA driverId/identidad (anti-rastreo). */
export interface NearbyVehicle {
  lat: number;
  lon: number;
  vehicleType: string;
}

/** Respuesta del feed de ambiente: lista de vehículos anónimos cercanos. */
export interface NearbyVehiclesView {
  vehicles: NearbyVehicle[];
}
