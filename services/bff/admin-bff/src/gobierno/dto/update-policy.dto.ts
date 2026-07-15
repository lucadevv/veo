import { IsBoolean, IsInt, IsObject, IsOptional, Min } from 'class-validator';

/**
 * Body del PUT /gobierno/policies/:key (parche PARCIAL: el superadmin toca `enabled` y/o `params`).
 * Espeja el UpdatePolicyDto interno de identity-service: class-validator solo asegura los TIPOS de
 * contenedor (boolean / objeto); la validación PROFUNDA de `params` (schema Zod por-política de @veo/policy)
 * la hace identity-service — fuente ÚNICA de forma (ADR-024 §9). Acá NO se re-valida por-política (no se
 * duplica el schema): el borde solo autoriza (RBAC SUPERADMIN + step-up) y reenvía; identity es el storage.
 */
export class UpdatePolicyDto {
  /** Nuevo estado on/off. identity lo rechaza (403) si la política es `mandatory` y se intenta `false`. */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** Nuevos parámetros tipados por la política. identity los valida contra su schema Zod (400 si inválidos). */
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;

  /** CAS optimista: la `version` que el admin tenía a la vista. identity aborta con 409 si la fila ya avanzó. */
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
