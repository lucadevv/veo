/**
 * DTO del PUT /admin/dispatch/radius-config en el admin-bff (defensa en profundidad).
 * El PUT REEMPLAZA la config de RADIOS (k-rings): validamos ambos enteros con class-validator —
 * espejo del DTO de dispatch-service, que RE-VALIDA aguas abajo. Mismas cotas [1..8]: un k-ring de 0
 * dejaría sin candidatos y uno enorme barrería media Lima saturando Redis/CPU del hot-path.
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

const K_RING_MIN = 1;
const K_RING_MAX = 8;

/** Body del PUT /admin/dispatch/radius-config — reemplazo de la config de radios (k-rings). */
export class ReplaceRadiusConfigDto {
  @ApiProperty({
    description: 'k-ring del feed de mapa de "autos cerca" (NearbyDriversService)',
    minimum: K_RING_MIN,
    maximum: K_RING_MAX,
    example: 3,
  })
  @IsInt()
  @Min(K_RING_MIN)
  @Max(K_RING_MAX)
  nearbyKRing!: number;

  @ApiProperty({
    description: 'k-ring del broadcast de pujas / matching (OfferBoardService)',
    minimum: K_RING_MIN,
    maximum: K_RING_MAX,
    example: 4,
  })
  @IsInt()
  @Min(K_RING_MIN)
  @Max(K_RING_MAX)
  matchKRing!: number;
}
