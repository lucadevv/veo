/**
 * DTOs del borde del carpooling del CONDUCTOR (driver-bff · ADR-014). El driver-bff RE-endurece el borde
 * (rango/tipo/enum) con class-validator ANTES de proxyar a booking-service — misma defensa en profundidad que
 * el resto del BFF (ver trips/dto). El `driverId` NUNCA se acepta del cliente: lo DERIVA el service server-side
 * (GetDriverByUser) y lo firma en la identidad interna (anti-IDOR). El contrato tipado (unions + tope de peaje)
 * se reusa de @veo/api-client (fuente única mobile↔BFF: CERO strings mágicos, CERO números mágicos).
 *
 * ValidationPipe global del BFF: `whitelist: true, transform: true` (recorta lo no declarado, castea query→num).
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CARPOOL_MAX_TOLLS_CENTS,
  carpoolModoReserva,
  type CarpoolModoReserva,
} from '@veo/api-client';

/** Una parada intermedia (ADR-014 §2.1). `orden` ≥1 (el 0 = origen, reservado). Espeja `carpoolStopover`. */
export class StopoverDto {
  @IsLatitude()
  lat!: number;

  @IsLongitude()
  lon!: number;

  @IsInt()
  @Min(1)
  orden!: number;
}

/** Selector de `orden` para `@ArrayUnique`: dos stopovers no pueden compartir orden (se pisarían). */
export const stopoverOrdenSelector = (s: StopoverDto): number => s.orden;

/** Precio de un tramo (ADR-014 §2.1). Dinero en céntimos PEN (Int). Espeja `carpoolTramoPrecio`. */
export class TramoPrecioDto {
  @IsInt()
  @Min(0)
  desdeOrden!: number;

  @IsInt()
  @Min(0)
  hastaOrden!: number;

  @IsInt()
  @Min(0)
  precioCentimos!: number;
}

/**
 * POST /carpool/trips → body (publicar la oferta). Espeja `CreatePublishedTripDto` de booking-service y
 * `publishTripRequest` del contrato mobile. Sin `driverId` (server-truth).
 */
export class PublishTripDto {
  @ApiProperty({ description: 'Vehículo con el que se publica (UUID, ref a fleet).' })
  @IsUUID()
  vehicleId!: string;

  @ApiProperty()
  @IsLatitude()
  origenLat!: number;

  @ApiProperty()
  @IsLongitude()
  origenLon!: number;

  @ApiProperty()
  @IsLatitude()
  destinoLat!: number;

  @ApiProperty()
  @IsLongitude()
  destinoLon!: number;

  @ApiPropertyOptional({
    type: [StopoverDto],
    description: 'Paradas intermedias (≤20, `orden` único ≥1).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique(stopoverOrdenSelector)
  @ValidateNested({ each: true })
  @Type(() => StopoverDto)
  stopovers?: StopoverDto[];

  @ApiProperty({ description: 'Salida PROGRAMADA en el futuro (ISO-8601).' })
  @IsISO8601({ strict: true })
  fechaHoraSalida!: string;

  @ApiProperty({ description: 'Asientos ofrecidos (1..8).' })
  @IsInt()
  @Min(1)
  @Max(8)
  asientosTotales!: number;

  @ApiProperty({ description: 'Precio del asiento full-route en céntimos PEN (Int).' })
  @IsInt()
  @Min(0)
  precioBase!: number;

  @ApiPropertyOptional({ type: [TramoPrecioDto], description: 'Pricing por tramo (≤40).' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => TramoPrecioDto)
  precioPorTramo?: TramoPrecioDto[];

  @ApiPropertyOptional({ description: `Peaje en céntimos PEN (0..${CARPOOL_MAX_TOLLS_CENTS}).` })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(CARPOOL_MAX_TOLLS_CENTS)
  tollsCents?: number;

  @ApiProperty({ enum: carpoolModoReserva.options })
  @IsIn(carpoolModoReserva.options)
  modoReserva!: CarpoolModoReserva;

  @ApiPropertyOptional({ description: 'Reglas del viaje (≤1000 chars).' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reglas?: string;
}

/**
 * PATCH /carpool/trips/:id → body (editar la oferta). Patch PARCIAL (todo opcional). Espeja
 * `UpdatePublishedTripDto` de booking-service y `updateTripRequest` del contrato mobile. NO editable:
 * `vehicleId`/país/moneda/pricingMode (el service lo impone). Sin `driverId`/`id` (van fuera del body).
 */
export class UpdateTripDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsLatitude()
  origenLat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  origenLon?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLatitude()
  destinoLat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  destinoLon?: number;

  @ApiPropertyOptional({ type: [StopoverDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique(stopoverOrdenSelector)
  @ValidateNested({ each: true })
  @Type(() => StopoverDto)
  stopovers?: StopoverDto[];

  @ApiPropertyOptional({ description: 'ISO-8601.' })
  @IsOptional()
  @IsISO8601({ strict: true })
  fechaHoraSalida?: string;

  @ApiPropertyOptional({ description: 'Asientos (1..8).' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  asientosTotales?: number;

  @ApiPropertyOptional({ description: 'Precio base en céntimos PEN (Int).' })
  @IsOptional()
  @IsInt()
  @Min(0)
  precioBase?: number;

  @ApiPropertyOptional({ type: [TramoPrecioDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => TramoPrecioDto)
  precioPorTramo?: TramoPrecioDto[];

  @ApiPropertyOptional({ description: `Peaje en céntimos PEN (0..${CARPOOL_MAX_TOLLS_CENTS}).` })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(CARPOOL_MAX_TOLLS_CENTS)
  tollsCents?: number;

  @ApiPropertyOptional({ enum: carpoolModoReserva.options })
  @IsOptional()
  @IsIn(carpoolModoReserva.options)
  modoReserva?: CarpoolModoReserva;

  @ApiPropertyOptional({ description: 'Reglas del viaje (≤1000 chars).' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reglas?: string;
}

/**
 * Query de las listas keyset del carpooling (GET /carpool/trips · GET /carpool/trips/:id/bookings). `limit`
 * acota la página (techo duro 100); `cursor` (id UUID del último item de la página previa) avanza. Ambos
 * opcionales (el service usa un default y la primera página). Espeja `ListMinePageDto`/`ListTripBookingsPageDto`.
 */
export class CarpoolPageQueryDto {
  @ApiPropertyOptional({ description: 'Tamaño de página (1..100). Default en el service.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Cursor keyset: id (UUID) del último item de la página previa.',
  })
  @IsOptional()
  @IsUUID()
  cursor?: string;
}
