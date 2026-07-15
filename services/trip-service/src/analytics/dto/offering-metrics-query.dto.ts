/**
 * Query del endpoint interno de métricas por-oferta (GET /internal/analytics/offering-metrics). El
 * `offeringId` es OBLIGATORIO y debe ser una oferta CONOCIDA: un `OfferingId` built-in (enum) O una oferta
 * CUSTOM (`custom_*`, ADR 013) — así la página-detalle de una oferta custom NO rompe (métricas 0 si no tiene
 * viajes). Un id fuera de ese set es 400 (defensa en profundidad; evita agregaciones sobre una `category`
 * arbitraria del cliente). No consulta la DB (sync): un custom_* inexistente simplemente agrega 0 viajes.
 */
import { registerDecorator, type ValidationOptions } from 'class-validator';
import { OfferingId, isCustomOfferingId } from '@veo/shared-types';

const OFFERING_IDS = Object.values(OfferingId) as string[];

function IsOfferingIdOrCustom(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isOfferingIdOrCustom',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          return (
            typeof value === 'string' && (OFFERING_IDS.includes(value) || isCustomOfferingId(value))
          );
        },
        defaultMessage(): string {
          return 'offeringId debe ser una oferta conocida (OfferingId) o una oferta custom (custom_*)';
        },
      },
    });
  };
}

export class OfferingMetricsQueryDto {
  @IsOfferingIdOrCustom()
  offeringId!: string;
}
