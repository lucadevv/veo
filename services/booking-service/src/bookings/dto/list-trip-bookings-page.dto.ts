/**
 * DTO de paginación de GET /published-trips/:id/bookings (F3b · driver-rail). El conductor lista las
 * SOLICITUDES de uno de sus viajes; un viaje muy demandado puede tener muchas reservas → NO se vuelca todo de
 * una: `limit` acota la página (con @Max, techo duro) y `cursor` (id de la última reserva de la página previa)
 * avanza por KEYSET. Ambos OPCIONALES: sin ellos, el service usa un default y la primera página. El BORDE se
 * endurece acá (tipo/rango), no en el service. Espeja `ListMinePageDto` de published-trips.
 */
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListTripBookingsPageDto {
  // Tamaño de página. @Type(Number) porque los query params llegan como string. Min 1, Max 100 (techo duro).
  // El default (20) lo aplica el service si no llega.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  // Cursor keyset: el `id` (UUID) de la última reserva de la página anterior. La siguiente página arranca
  // DESPUÉS de esa fila. Sin cursor → primera página.
  @IsOptional()
  @IsUUID()
  cursor?: string;
}
