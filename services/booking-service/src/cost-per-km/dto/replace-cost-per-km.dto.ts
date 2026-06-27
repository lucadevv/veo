/**
 * DTO del endpoint interno del costo/km por país (F2.5). El costo va en CÉNTIMOS PEN Int (jamás float).
 * `expectedVersion` = optimistic locking (CAS) per-país. Espeja ReplaceCommissionDto de payment-service.
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, Max, Min } from 'class-validator';
import { PAIS } from '../../domain/cost-cap';

/** Países soportados como tupla literal (fuente única en el dominio). El borde rechaza cualquier otro. */
const PAISES = [PAIS.PE, PAIS.EC] as const;

/** Tope de cordura del costo/km en el borde (defensa en profundidad; el dominio re-valida). S/0.01 .. S/100. */
const MAX_COST_PER_KM_CENTS = 10_000;

export class ReplaceCostPerKmDto {
  @ApiProperty({
    description: 'País del costo/km (PE/EC). Cada país versiona su tarifa por separado (CAS).',
    enum: PAISES,
  })
  @IsIn(PAISES)
  pais!: (typeof PAISES)[number];

  @ApiProperty({
    description:
      'Costo de OPERACIÓN por km en céntimos PEN (combustible + desgaste). Int, jamás float. PE real = 150 (S/1.50/km).',
    minimum: 1,
    maximum: MAX_COST_PER_KM_CENTS,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_COST_PER_KM_CENTS)
  costPerKmCents!: number;

  @ApiProperty({
    description:
      'Optimistic locking (CAS): la `version` que el cliente cargó. El server REEMPLAZA solo si la versión ' +
      'vigente del país sigue siendo esta; si otro admin la movió → 409 ConflictError. 0 = primer write.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
