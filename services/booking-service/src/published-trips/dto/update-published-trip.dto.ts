/**
 * DTO de edición de un PublishedTrip (PATCH /published-trips/:id). ADR-014 §8 · F1a (driver-rail).
 *
 * Todos los campos son OPCIONALES (patch parcial): el conductor edita solo lo que cambia. El `driverId`
 * NUNCA viene del body (ownership server-truth, anti-IDOR); el `id` viene del path. Editable SOLO mientras
 * la oferta está PUBLICADO (sin reservas confirmadas / pre-EN_RUTA) — la regla de editabilidad la impone el
 * service contra la máquina de estados, no el DTO. El DTO solo endurece el BORDE (rango/tipo/enum).
 *
 * Campos editables (ADR-014): itinerario (origen/destino/stopovers/fecha) · precio (base + por tramo) ·
 * asientos · modoReserva · reglas. NO editables: vehicleId (re-publicar con otro vehículo es otra oferta;
 * además cambiar el vehículo requeriría re-validar anti-IDOR — fuera de scope F1a), país/moneda/pricingMode.
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
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ModoReserva } from '../../generated/prisma';
import { StopoverDto, TramoPrecioDto, stopoverOrdenSelector } from './create-published-trip.dto';
import { MAX_TOLLS_CENTS } from '../../domain/cost-cap';

export class UpdatePublishedTripDto {
  @IsOptional()
  @IsLatitude()
  origenLat?: number;

  @IsOptional()
  @IsLongitude()
  origenLon?: number;

  @IsOptional()
  @IsLatitude()
  destinoLat?: number;

  @IsOptional()
  @IsLongitude()
  destinoLon?: number;

  // @ArrayUnique sobre el `orden` (mismo invariante que el create): dos stopovers no pueden compartir orden.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique(stopoverOrdenSelector)
  @ValidateNested({ each: true })
  @Type(() => StopoverDto)
  stopovers?: StopoverDto[];

  // Viaje PROGRAMADO: la validación temporal fina (futuro) la re-aplica el service si llega.
  @IsOptional()
  @IsISO8601({ strict: true })
  fechaHoraSalida?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  asientosTotales?: number;

  // Precio del asiento full-route en CÉNTIMOS PEN (Int, nunca float).
  @IsOptional()
  @IsInt()
  @Min(0)
  precioBase?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => TramoPrecioDto)
  precioPorTramo?: TramoPrecioDto[];

  // Peaje del viaje en CÉNTIMOS PEN (Int, nunca float). Editable; se SUMA al costo y RECIÉN se divide entre
  // asientos en el tope. Topado por MAX_TOLLS_CENTS (techo de cordura). Tocarlo re-valida el gate F1b.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_TOLLS_CENTS)
  tollsCents?: number;

  @IsOptional()
  @IsEnum(ModoReserva)
  modoReserva?: ModoReserva;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reglas?: string;
}
