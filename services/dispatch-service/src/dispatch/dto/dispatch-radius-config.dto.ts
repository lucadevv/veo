/**
 * DTO del PUT /internal/dispatch/radius-config — reemplazo de la config de RADIOS (k-rings) + VENTANAS
 * de dispatch. Validamos los enteros con class-validator (primera barrera; el service es la segunda).
 * K-ring [1..8]: 0 dejaría sin candidatos y uno enorme barrería media Lima. Ventanas acotadas anti-footgun:
 * offerTimeoutMs [5000..120000] (una oferta directa razonable), bidWindowSec [15..300] (un board de PUJA).
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

/** Tope superior del k-ring (anti-footgun: un radio enorme satura Redis/CPU del hot-path). */
const K_RING_MIN = 1;
const K_RING_MAX = 8;
/** Cotas de la ventana de la oferta directa FIXED (ms). */
const OFFER_TIMEOUT_MS_MIN = 5_000;
const OFFER_TIMEOUT_MS_MAX = 120_000;
/** Cotas de la ventana del board de PUJA (s). */
const BID_WINDOW_SEC_MIN = 15;
const BID_WINDOW_SEC_MAX = 300;

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
