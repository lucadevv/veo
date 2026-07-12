/**
 * Query del endpoint interno de métricas por-oferta (GET /internal/analytics/offering-metrics). El
 * `offeringId` es OBLIGATORIO y debe ser un OfferingId CONOCIDO del catálogo (fuente única: el enum de
 * @veo/shared-types) — un id fuera del set es 400 (defensa en profundidad; el admin-bff ya lo restringe a
 * los ids que sirve `GET /catalog`). Evita agregaciones sobre una `category` arbitraria del cliente.
 */
import { IsIn } from 'class-validator';
import { OfferingId } from '@veo/shared-types';

const OFFERING_IDS = Object.values(OfferingId);

export class OfferingMetricsQueryDto {
  @IsIn(OFFERING_IDS)
  offeringId!: string;
}
