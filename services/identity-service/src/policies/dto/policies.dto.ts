import { IsBoolean, IsObject, IsOptional } from 'class-validator';
import type { PolicyParams } from '@veo/policy';

/**
 * Body del PUT /internal/policies/:key. Parche PARCIAL: el admin toca `enabled` y/o `params`.
 * class-validator solo asegura los TIPOS de contenedor (boolean / objeto); la validación PROFUNDA de `params`
 * (por schema Zod de la key) la hace PoliciesService con @veo/policy — fuente única de forma (ADR §9).
 */
export class UpdatePolicyDto {
  /** Nuevo estado on/off. Rechazado si la política es `mandatory` y se intenta `false` (Ley 29733). */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** Nuevos parámetros tipados por la política. Validados contra su schema Zod en el service. */
  @IsOptional()
  @IsObject()
  params?: PolicyParams;
}
