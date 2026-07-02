/**
 * DTO del PUT /admin/dispatch/radius-config en el admin-bff (defensa en profundidad).
 * El PUT REEMPLAZA la config de RADIOS (k-rings) + VENTANAS: validamos los enteros con class-validator —
 * espejo del DTO de dispatch-service, que RE-VALIDA aguas abajo. Cotas de k-ring [1..8]: un k-ring de 0
 * dejaría sin candidatos y uno enorme barrería media Lima. Ventanas acotadas anti-footgun:
 * offerTimeoutMs [5000..120000] ms, bidWindowSec [15..300] s.
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

const K_RING_MIN = 1;
const K_RING_MAX = 8;
const OFFER_TIMEOUT_MS_MIN = 5_000;
const OFFER_TIMEOUT_MS_MAX = 120_000;
const BID_WINDOW_SEC_MIN = 15;
const BID_WINDOW_SEC_MAX = 300;

/** Body del PUT /admin/dispatch/radius-config — reemplazo de la config de radios (k-rings) + ventanas. */
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

  @ApiProperty({
    description: 'Ventana (ms) de la oferta directa FIXED antes de TIMEOUT + avanzar',
    minimum: OFFER_TIMEOUT_MS_MIN,
    maximum: OFFER_TIMEOUT_MS_MAX,
    example: 12_000,
  })
  @IsInt()
  @Min(OFFER_TIMEOUT_MS_MIN)
  @Max(OFFER_TIMEOUT_MS_MAX)
  offerTimeoutMs!: number;

  @ApiProperty({
    description: 'Ventana (s) del board de PUJA (openBoard/reopenBoard)',
    minimum: BID_WINDOW_SEC_MIN,
    maximum: BID_WINDOW_SEC_MAX,
    example: 60,
  })
  @IsInt()
  @Min(BID_WINDOW_SEC_MIN)
  @Max(BID_WINDOW_SEC_MAX)
  bidWindowSec!: number;
}
