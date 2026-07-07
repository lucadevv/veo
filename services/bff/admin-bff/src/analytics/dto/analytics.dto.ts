/** DTOs de analítica del dashboard admin. */
import { IsIn, IsOptional } from 'class-validator';
import { revenueRange, type RevenueRangeValue } from '@veo/api-client';

/**
 * Query de la pantalla "Métricas" (GET /analytics/revenue). `range` OPCIONAL (default `today` lo resuelve el
 * controller). Se valida contra el enum del contrato (`revenueRange.options` · fuente única del literal) — no un
 * array de strings sueltos: agregar/quitar un rango en el contrato propaga acá sin duplicar el set.
 */
export class RevenueQueryDto {
  @IsOptional()
  @IsIn(revenueRange.options)
  range?: RevenueRangeValue;
}
