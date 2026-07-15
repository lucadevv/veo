/**
 * DTO del PUT /internal/dispatch/radius-config — reemplazo de la config de RADIOS (k-rings) + VENTANAS
 * de dispatch + POLÍTICA v2 (feature-flag). Validamos con class-validator (primera barrera; el service es
 * la segunda). K-ring [1..8]: 0 dejaría sin candidatos y uno enorme barrería media Lima. Ventanas acotadas
 * anti-footgun: offerTimeoutMs [5000..120000], bidWindowSec [15..300].
 *
 * Política v2 (razona en KM): FIXED { initialRadiusKm, incrementKm, maxRadiusKm, targetDrivers,
 * offerTimeoutSec, expandIntervalSec } + PUJA { broadcastRadiusKm, bidWindowSec }. Cotas en POLICY_BOUNDS
 * (fuente única compartida con el helper puro). `policyVersion='v2'` EXIGE `policyV2` presente y válido.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
  IsDefined,
} from 'class-validator';
import { POLICY_BOUNDS } from '../dispatch-policy';

/** Tope superior del k-ring (anti-footgun: un radio enorme satura Redis/CPU del hot-path). */
const K_RING_MIN = 1;
const K_RING_MAX = 8;
/** Cotas de la ventana de la oferta directa FIXED (ms). */
const OFFER_TIMEOUT_MS_MIN = 5_000;
const OFFER_TIMEOUT_MS_MAX = 120_000;
/** Cotas de la ventana del board de PUJA (s). */
const BID_WINDOW_SEC_MIN = 15;
const BID_WINDOW_SEC_MAX = 300;

/** Política FIXED v2 (matcher secuencial) — radios en km + umbral de candidatos + ventanas. */
export class FixedPolicyDto {
  @ApiProperty({ minimum: POLICY_BOUNDS.radiusKm.min, maximum: POLICY_BOUNDS.radiusKm.max, example: 0.6 })
  @IsNumber()
  @Min(POLICY_BOUNDS.radiusKm.min)
  @Max(POLICY_BOUNDS.radiusKm.max)
  initialRadiusKm!: number;

  @ApiProperty({
    minimum: POLICY_BOUNDS.incrementKm.min,
    maximum: POLICY_BOUNDS.incrementKm.max,
    example: 0.3,
  })
  @IsNumber()
  @Min(POLICY_BOUNDS.incrementKm.min)
  @Max(POLICY_BOUNDS.incrementKm.max)
  incrementKm!: number;

  @ApiProperty({ minimum: POLICY_BOUNDS.radiusKm.min, maximum: POLICY_BOUNDS.radiusKm.max, example: 1.5 })
  @IsNumber()
  @Min(POLICY_BOUNDS.radiusKm.min)
  @Max(POLICY_BOUNDS.radiusKm.max)
  maxRadiusKm!: number;

  @ApiProperty({
    minimum: POLICY_BOUNDS.targetDrivers.min,
    maximum: POLICY_BOUNDS.targetDrivers.max,
    example: 3,
    description: 'Umbral de candidatos: expande el ring hasta juntar ≥ N (nunca broadcast; oferta a 1).',
  })
  @IsInt()
  @Min(POLICY_BOUNDS.targetDrivers.min)
  @Max(POLICY_BOUNDS.targetDrivers.max)
  targetDrivers!: number;

  @ApiProperty({
    minimum: POLICY_BOUNDS.offerTimeoutSec.min,
    maximum: POLICY_BOUNDS.offerTimeoutSec.max,
    example: 20,
  })
  @IsInt()
  @Min(POLICY_BOUNDS.offerTimeoutSec.min)
  @Max(POLICY_BOUNDS.offerTimeoutSec.max)
  offerTimeoutSec!: number;

  @ApiProperty({
    minimum: POLICY_BOUNDS.expandIntervalSec.min,
    maximum: POLICY_BOUNDS.expandIntervalSec.max,
    example: 8,
    description: 'Cadencia (s) de expansión TEMPORAL del ring, desacoplada del timeout de la oferta.',
  })
  @IsInt()
  @Min(POLICY_BOUNDS.expandIntervalSec.min)
  @Max(POLICY_BOUNDS.expandIntervalSec.max)
  expandIntervalSec!: number;
}

/** Política PUJA v2 (broadcast single-shot) — radio de broadcast en km + ventana del board. */
export class PujaPolicyDto {
  @ApiProperty({ minimum: POLICY_BOUNDS.radiusKm.min, maximum: POLICY_BOUNDS.radiusKm.max, example: 1.2 })
  @IsNumber()
  @Min(POLICY_BOUNDS.radiusKm.min)
  @Max(POLICY_BOUNDS.radiusKm.max)
  broadcastRadiusKm!: number;

  @ApiProperty({
    minimum: POLICY_BOUNDS.bidWindowSec.min,
    maximum: POLICY_BOUNDS.bidWindowSec.max,
    example: 60,
  })
  @IsInt()
  @Min(POLICY_BOUNDS.bidWindowSec.min)
  @Max(POLICY_BOUNDS.bidWindowSec.max)
  bidWindowSec!: number;
}

/** Snapshot v2 por-modo. */
export class DispatchPolicyV2Dto {
  @ApiProperty({ type: FixedPolicyDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => FixedPolicyDto)
  FIXED!: FixedPolicyDto;

  @ApiProperty({ type: PujaPolicyDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => PujaPolicyDto)
  PUJA!: PujaPolicyDto;
}

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

  @ApiPropertyOptional({
    description: 'Feature-flag de política de despacho. Ausente → v1 (comportamiento actual).',
    enum: ['v1', 'v2'],
    default: 'v1',
    example: 'v1',
  })
  @IsOptional()
  @IsIn(['v1', 'v2'])
  policyVersion?: 'v1' | 'v2';

  @ApiPropertyOptional({
    type: DispatchPolicyV2Dto,
    description: 'Snapshot v2 por-modo. OBLIGATORIO y validado cuando policyVersion=v2; ignorado en v1.',
  })
  // policyV2 es OBLIGATORIO si (y solo si) policyVersion==='v2'. En v1 se ignora (puede venir null/ausente).
  @ValidateIf((o: ReplaceRadiusConfigDto) => o.policyVersion === 'v2')
  @IsDefined({ message: 'policyV2 es obligatorio cuando policyVersion=v2' })
  @ValidateNested()
  @Type(() => DispatchPolicyV2Dto)
  policyV2?: DispatchPolicyV2Dto | null;
}
