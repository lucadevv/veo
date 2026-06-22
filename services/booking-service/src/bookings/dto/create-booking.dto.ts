/**
 * DTO de creación de un Booking (POST /bookings). ADR-014 §2.2 / §8 (public-rail).
 * El `passengerId` NO viene del body: se toma de la identidad firmada del pasajero (server-truth,
 * anti-IDOR). Dinero (specialRequest) en céntimos PEN (Int), nunca float.
 */
import {
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaymentMethod } from '@veo/shared-types';

export class CreateBookingDto {
  // Oferta sobre la que se reserva (PublishedTrip, mismo schema 'booking').
  @IsUUID()
  publishedTripId!: string;

  @IsInt()
  @Min(1)
  @Max(8)
  asientos!: number;

  // MÉTODO DE PAGO elegido por el pasajero al reservar (ADR-014 §5.5 · decisión del dueño 2026-06-22).
  // OBLIGATORIO y TIPADO: @IsEnum contra el PaymentMethod de @veo/shared-types (fuente única del monorepo,
  // CERO strings mágicos). El CHARGE al aprobar (o al reservar si INSTANT) lo usa. La afiliación Yape on-file
  // (QR-vs-on-file) la decide payment server-side — booking NO valida afiliación, solo pasa el método.
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

  // Mensaje al conductor (opcional, modo REVISION).
  @IsOptional()
  @IsString()
  @MaxLength(500)
  mensajeIntro?: string;

  // Top-up sobre la base en CÉNTIMOS PEN (Int). Opcional. ADR-014 §2.2 `specialRequest`.
  // @Max = tope de dominio S/100.000 (= 100_000_00 céntimos). Corta en validación (400) el overflow del
  // Int de Postgres en `precioAcordado = precioBase + specialRequest` (2^31 ≈ S/21.4M) antes de que sea 500.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_00)
  specialRequest?: number;
}
