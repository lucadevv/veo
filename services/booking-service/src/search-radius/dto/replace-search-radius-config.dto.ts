/**
 * DTO del PUT /internal/booking/search-radius-config — reemplazo del RADIO de búsqueda del carpooling. Los
 * radios van en KM (unidad del admin); el service los mapea a k-rings H3 en runtime. Validamos los rangos con
 * class-validator (primera barrera; el service re-valida — defensa en profundidad).
 *
 * COTAS (mapeadas a k-ring res-9 ≈ 0.3km/anillo, ceil):
 *  - baseRadiusKm   0.0 .. 1.5  → k0 (solo la celda) .. k5.
 *  - expandRadiusKm 0.3 .. 2.4  → k1 .. k8 (el tope del hot-path). El expand debe ser ≥ base (lo re-valida el service).
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Max, Min } from 'class-validator';

/** Cotas del radio base (km). 0 = solo la celda de origen; 1.5km ≈ k5 (radio urbano amplio). */
export const BASE_RADIUS_KM_MIN = 0.0;
export const BASE_RADIUS_KM_MAX = 1.5;
/** Cotas del radio expandido (km). ≥ 0.3km (al menos k1); 2.4km ≈ k8 (tope anti-footgun del hot-path). */
export const EXPAND_RADIUS_KM_MIN = 0.3;
export const EXPAND_RADIUS_KM_MAX = 2.4;

export class ReplaceSearchRadiusConfigDto {
  @ApiProperty({
    description: 'Radio BASE de la búsqueda (km). Se mapea a k-ring H3 res-9 (~0.3km/anillo, ceil). 0 = solo la celda de origen.',
    minimum: BASE_RADIUS_KM_MIN,
    maximum: BASE_RADIUS_KM_MAX,
    example: 0.3,
  })
  @IsNumber()
  @Min(BASE_RADIUS_KM_MIN)
  @Max(BASE_RADIUS_KM_MAX)
  baseRadiusKm!: number;

  @ApiProperty({
    description: 'Radio EXPANDIDO (km): la búsqueda reintenta con este si la base da 0 resultados. Debe ser ≥ baseRadiusKm.',
    minimum: EXPAND_RADIUS_KM_MIN,
    maximum: EXPAND_RADIUS_KM_MAX,
    example: 0.6,
  })
  @IsNumber()
  @Min(EXPAND_RADIUS_KM_MIN)
  @Max(EXPAND_RADIUS_KM_MAX)
  expandRadiusKm!: number;
}
