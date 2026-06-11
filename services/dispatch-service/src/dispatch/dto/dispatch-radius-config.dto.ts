/**
 * DTO del PUT /internal/dispatch/radius-config — reemplazo de la config de RADIOS (k-rings) de dispatch.
 * Validamos ambos enteros con class-validator (primera barrera; el service es la segunda). Límites
 * razonables [1..8]: un k-ring de 0 dejaría sin candidatos y uno enorme barrería media Lima.
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

/** Tope superior del k-ring (anti-footgun: un radio enorme satura Redis/CPU del hot-path). */
const K_RING_MIN = 1;
const K_RING_MAX = 8;

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
