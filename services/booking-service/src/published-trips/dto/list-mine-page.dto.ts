/**
 * DTO de paginación de GET /published-trips/mine (F1 FIX 5). El conductor con 500 ofertas NO debe recibir
 * todo de una: `limit` acota el tamaño de página (con @Max para que el cliente no pida un volcado completo)
 * y `cursor` (id de la última oferta de la página previa) avanza por KEYSET. Ambos OPCIONALES: sin ellos, el
 * service usa un default razonable y la primera página. El BORDE se endurece acá (tipo/rango), no en el service.
 */
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListMinePageDto {
  // Tamaño de página. @Type(Number) porque los query params llegan como string. Min 1, Max 100 (techo duro:
  // ni con intención el cliente vuelca toda la tabla). El default (20) lo aplica el service si no llega.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  // Cursor keyset: el `id` (UUID) de la última oferta de la página anterior. La siguiente página arranca
  // DESPUÉS de esa fila. Sin cursor → primera página.
  @IsOptional()
  @IsUUID()
  cursor?: string;
}
