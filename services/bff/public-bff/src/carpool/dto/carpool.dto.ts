/**
 * DTOs del carpooling del PASAJERO (ADR-014 · public-rail). Espejan los DTOs de booking-service
 * (SearchPublishedTripsDto / CreateBookingDto): el BFF valida en el borde y el downstream REVALIDA
 * (defensa en profundidad, misma regla que trips/payments). El `passengerId` NUNCA viaja en el body:
 * lo deriva la identidad firmada (server-truth, anti-IDOR).
 */
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaymentMethod } from '@veo/shared-types';

/** Fecha-calendario PURA `YYYY-MM-DD` (sin hora ni offset) — booking-service la interpreta en hora Lima. */
const CALENDAR_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export class SearchCarpoolTripsDto {
  // ── Ruta A→B que busca el pasajero. ──
  @Type(() => Number)
  @IsLatitude()
  originLat!: number;

  @Type(() => Number)
  @IsLongitude()
  originLon!: number;

  @Type(() => Number)
  @IsLatitude()
  destLat!: number;

  @Type(() => Number)
  @IsLongitude()
  destLon!: number;

  // Día de salida como fecha-calendario pura (el downstream corta datetime/offset con el mismo doble gate).
  @Matches(CALENDAR_DATE_REGEX, {
    message: 'fecha debe ser una fecha-calendario YYYY-MM-DD (sin hora ni offset)',
  })
  @IsISO8601({ strict: true })
  fecha!: string;

  // Asientos que necesita (la oferta debe tener disponibles >= este valor).
  @Type(() => Number)
  @IsInt()
  @Min(1)
  asientos!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  /** Cursor keyset OPACO de la página previa (su forma interna la valida el downstream). */
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class CreateCarpoolBookingDto {
  @IsUUID()
  publishedTripId!: string;

  @IsInt()
  @Min(1)
  @Max(8)
  asientos!: number;

  // Método de pago elegido al reservar (el CHARGE al aprobar lo usa) — enum compartido, cero strings mágicos.
  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @IsLatitude()
  pickupLat!: number;

  @IsLongitude()
  pickupLon!: number;

  @IsLatitude()
  dropoffLat!: number;

  @IsLongitude()
  dropoffLon!: number;

  // Mensaje de presentación al conductor (modo REVISION).
  @IsOptional()
  @IsString()
  @MaxLength(500)
  mensajeIntro?: string;

  // Top-up en céntimos PEN sobre la base (mismo tope de dominio que el downstream: S/100.000).
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_00)
  specialRequest?: number;
}
