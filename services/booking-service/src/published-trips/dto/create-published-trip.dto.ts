/**
 * DTO de creación de un PublishedTrip (POST /published-trips). ADR-014 §2.1 / §8 (driver-rail).
 * Endurecimiento del borde (class-validator): geo en rango, asientos > 0, precio en céntimos Int >= 0,
 * modo de reserva del enum tipado. El `driverId` NO viene del body: se toma de la identidad firmada del
 * conductor (server-truth, anti-IDOR). Dinero SIEMPRE en céntimos (Int), nunca float.
 */
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
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
import { Type } from 'class-transformer';
import { ModoReserva } from '../../generated/prisma';

/**
 * Una parada intermedia de la ruta (ADR-014 §2.1 `stopovers`). El `orden` arranca en 1: el 0 está RESERVADO
 * al origen (hito implícito), y el destino es el hito propio n+1. Un stopover en orden 0 pisaría el origen;
 * la unicidad (a nivel del array contenedor, `@ArrayUnique`) evita que dos stopovers compartan orden y se
 * pisen. Borde anti-lucro: sin esto, un orden colisionante inflaría la distancia del tramo → tope inflado.
 */
export class StopoverDto {
  @IsLatitude()
  lat!: number;

  @IsLongitude()
  lon!: number;

  // orden ≥ 1: el 0 es el origen (reservado). El dominio re-valida {1..n} contiguo (defensa en profundidad).
  @IsInt()
  @Min(1)
  orden!: number;
}

/** Selector de `orden` para `@ArrayUnique`: los stopovers de una ruta no pueden compartir orden (se pisarían). */
export const stopoverOrdenSelector = (s: StopoverDto): number => s.orden;

/** Precio de un tramo (ADR-014 §2.1 `precioPorTramo`). Dinero en céntimos PEN (Int). */
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

export class CreatePublishedTripDto {
  // Vehículo con el que se publica (ref a fleet por ID; sin FK cross-schema).
  @IsUUID()
  vehicleId!: string;

  @IsLatitude()
  origenLat!: number;

  @IsLongitude()
  origenLon!: number;

  @IsLatitude()
  destinoLat!: number;

  @IsLongitude()
  destinoLon!: number;

  // Paradas intermedias (F0 las acepta y persiste; el pricing por tramo en la UI es F1).
  // @ArrayUnique sobre el `orden`: dos stopovers no pueden compartir orden (se pisarían al armar los hitos →
  // distancia de tramo inflada → tope inflado). El dominio re-valida {1..n} contiguo (defensa en profundidad).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique(stopoverOrdenSelector)
  @ValidateNested({ each: true })
  @Type(() => StopoverDto)
  stopovers?: StopoverDto[];

  // Viaje PROGRAMADO: fecha/hora de salida en el FUTURO (la validación temporal fina es del service).
  @IsISO8601({ strict: true })
  fechaHoraSalida!: string;

  @IsInt()
  @Min(1)
  @Max(8)
  asientosTotales!: number;

  // Precio del asiento full-route en CÉNTIMOS PEN (Int, nunca float).
  @IsInt()
  @Min(0)
  precioBase!: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => TramoPrecioDto)
  precioPorTramo?: TramoPrecioDto[];

  // Modo de reserva — enum TIPADO (INSTANT_BOOKING | REVISION_CADA_SOLICITUD). Sin string mágico.
  @IsEnum(ModoReserva)
  modoReserva!: ModoReserva;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reglas?: string;
}
