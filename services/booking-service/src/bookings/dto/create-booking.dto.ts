/**
 * DTO de creación de un Booking (POST /bookings). ADR-014 §2.2 / §8 (public-rail).
 * El `passengerId` NO viene del body: se toma de la identidad firmada del pasajero (server-truth,
 * anti-IDOR). Dinero (specialRequest) en céntimos PEN (Int), nunca float.
 */
import {
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

export class CreateBookingDto {
  // Oferta sobre la que se reserva (PublishedTrip, mismo schema 'booking').
  @IsUUID()
  publishedTripId!: string;

  @IsInt()
  @Min(1)
  @Max(8)
  asientos!: number;

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
