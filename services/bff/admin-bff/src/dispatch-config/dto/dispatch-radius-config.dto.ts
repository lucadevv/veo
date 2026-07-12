/**
 * DTO del PUT /admin/dispatch/radius-config en el admin-bff (defensa en profundidad).
 * El PUT REEMPLAZA la config de RADIOS (k-rings) + VENTANAS: validamos los enteros con class-validator —
 * espejo del DTO de dispatch-service, que RE-VALIDA aguas abajo. Cotas de k-ring [1..8]: un k-ring de 0
 * dejaría sin candidatos y uno enorme barrería media Lima. Ventanas acotadas anti-footgun:
 * offerTimeoutMs [5000..120000] ms, bidWindowSec [15..300] s.
 *
 * v2 (política geométrica por modo, OPCIONAL · back-compat): `policyVersion` ∈ {v1,v2} + `policyV2` con los
 * bloques FIXED/PUJA (radios en KM float, ventanas en s). Cotas de cordura espejo de dispatch-service.
 */
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateNested,
  ValidateBy,
  type ValidationOptions,
  buildMessage,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Cross-field: la propiedad decorada debe ser >= la propiedad hermana `property`. */
function IsGteField(property: string, options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isGteField',
      constraints: [property],
      validator: {
        validate: (value, args): boolean => {
          if (!args) return false;
          const other = (args.object as Record<string, unknown>)[args.constraints[0] as string];
          return typeof value === 'number' && typeof other === 'number' && value >= other;
        },
        defaultMessage: buildMessage(
          (each) => `${each}$property must be >= $constraint1`,
          options,
        ),
      },
    },
    options,
  );
}

const K_RING_MIN = 1;
const K_RING_MAX = 8;
const OFFER_TIMEOUT_MS_MIN = 5_000;
const OFFER_TIMEOUT_MS_MAX = 120_000;
const BID_WINDOW_SEC_MIN = 15;
const BID_WINDOW_SEC_MAX = 300;

// Cotas de cordura de la política geométrica v2 (espejo de dispatch-service).
const RADIUS_KM_MIN = 0.3;
const RADIUS_KM_MAX = 2.4;
const INCREMENT_KM_MIN = 0.1;
const INCREMENT_KM_MAX = 1.0;
const TARGET_DRIVERS_MIN = 1;
const TARGET_DRIVERS_MAX = 20;
const OFFER_TIMEOUT_SEC_MIN = 5;
const OFFER_TIMEOUT_SEC_MAX = 120;
const EXPAND_INTERVAL_SEC_MIN = 2;
const EXPAND_INTERVAL_SEC_MAX = 60;

/** Política v2 del modo FIXED — radio inicial + expansión geométrica por anillos hasta el máximo. */
export class FixedPolicyDto {
  @ApiProperty({ minimum: RADIUS_KM_MIN, maximum: RADIUS_KM_MAX, example: 0.5 })
  @IsNumber()
  @Min(RADIUS_KM_MIN)
  @Max(RADIUS_KM_MAX)
  initialRadiusKm!: number;

  @ApiProperty({ minimum: INCREMENT_KM_MIN, maximum: INCREMENT_KM_MAX, example: 0.3 })
  @IsNumber()
  @Min(INCREMENT_KM_MIN)
  @Max(INCREMENT_KM_MAX)
  incrementKm!: number;

  @ApiProperty({ minimum: RADIUS_KM_MIN, maximum: RADIUS_KM_MAX, example: 2.0 })
  @IsNumber()
  @Min(RADIUS_KM_MIN)
  @Max(RADIUS_KM_MAX)
  maxRadiusKm!: number;

  @ApiProperty({ minimum: TARGET_DRIVERS_MIN, maximum: TARGET_DRIVERS_MAX, example: 5 })
  @IsInt()
  @Min(TARGET_DRIVERS_MIN)
  @Max(TARGET_DRIVERS_MAX)
  targetDrivers!: number;

  @ApiProperty({ minimum: OFFER_TIMEOUT_SEC_MIN, maximum: OFFER_TIMEOUT_SEC_MAX, example: 12 })
  @IsInt()
  @Min(OFFER_TIMEOUT_SEC_MIN)
  @Max(OFFER_TIMEOUT_SEC_MAX)
  offerTimeoutSec!: number;

  @ApiProperty({ minimum: EXPAND_INTERVAL_SEC_MIN, maximum: EXPAND_INTERVAL_SEC_MAX, example: 8 })
  @IsInt()
  @Min(EXPAND_INTERVAL_SEC_MIN)
  @Max(EXPAND_INTERVAL_SEC_MAX)
  expandIntervalSec!: number;
}

/** Política v2 del modo PUJA — broadcast a un radio único + ventana del board. */
export class PujaPolicyDto {
  @ApiProperty({ minimum: RADIUS_KM_MIN, maximum: RADIUS_KM_MAX, example: 1.5 })
  @IsNumber()
  @Min(RADIUS_KM_MIN)
  @Max(RADIUS_KM_MAX)
  broadcastRadiusKm!: number;

  @ApiProperty({ minimum: BID_WINDOW_SEC_MIN, maximum: BID_WINDOW_SEC_MAX, example: 60 })
  @IsInt()
  @Min(BID_WINDOW_SEC_MIN)
  @Max(BID_WINDOW_SEC_MAX)
  bidWindowSec!: number;
}

/** Bloque de política geométrica v2 por modo (FIXED + PUJA). */
export class DispatchPolicyV2Dto {
  @ApiProperty({ type: FixedPolicyDto })
  @ValidateNested()
  @Type(() => FixedPolicyDto)
  FIXED!: FixedPolicyDto;

  @ApiProperty({ type: PujaPolicyDto })
  @ValidateNested()
  @Type(() => PujaPolicyDto)
  PUJA!: PujaPolicyDto;
}

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

  @ApiProperty({
    description: 'Versión de política: v1 (solo k-rings) o v2 (geométrica por modo). Opcional (back-compat).',
    enum: ['v1', 'v2'],
    required: false,
  })
  @IsOptional()
  @IsIn(['v1', 'v2'])
  policyVersion?: 'v1' | 'v2';

  @ApiProperty({
    type: DispatchPolicyV2Dto,
    description: 'Política geométrica por modo (FIXED/PUJA). Opcional — solo cuando policyVersion==="v2".',
    required: false,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => DispatchPolicyV2Dto)
  policyV2?: DispatchPolicyV2Dto;
}

// Cotas de cordura del radio de búsqueda del carpooling (booking-service). expand >= base lo valida el DTO.
const CARPOOL_BASE_KM_MIN = 0.0;
const CARPOOL_BASE_KM_MAX = 1.5;
const CARPOOL_EXPAND_KM_MIN = 0.3;
const CARPOOL_EXPAND_KM_MAX = 2.4;

/**
 * Body del PUT /admin/dispatch/carpool-radius-config — radios de búsqueda del carpooling (booking-service).
 * Invariante: `expandRadiusKm >= baseRadiusKm` (el radio ampliado no puede quedar por debajo del inicial).
 */
export class ReplaceCarpoolConfigDto {
  @ApiProperty({
    description: 'Radio inicial de búsqueda del carpooling (km)',
    minimum: CARPOOL_BASE_KM_MIN,
    maximum: CARPOOL_BASE_KM_MAX,
    example: 0.8,
  })
  @IsNumber()
  @Min(CARPOOL_BASE_KM_MIN)
  @Max(CARPOOL_BASE_KM_MAX)
  baseRadiusKm!: number;

  @ApiProperty({
    description: 'Radio ampliado si el base no cubre (km). Debe ser >= baseRadiusKm.',
    minimum: CARPOOL_EXPAND_KM_MIN,
    maximum: CARPOOL_EXPAND_KM_MAX,
    example: 1.5,
  })
  @IsNumber()
  @Min(CARPOOL_EXPAND_KM_MIN)
  @Max(CARPOOL_EXPAND_KM_MAX)
  @IsGteField('baseRadiusKm')
  expandRadiusKm!: number;
}

/** Query del radar de dispatch (?mode=FIXED|PUJA&lat=&lon=). */
export class DispatchRadarQueryDto {
  @ApiProperty({ enum: ['FIXED', 'PUJA'], example: 'FIXED' })
  @IsIn(['FIXED', 'PUJA'])
  mode!: 'FIXED' | 'PUJA';

  @ApiProperty({ example: -12.0464 })
  @Type(() => Number)
  @IsNumber()
  lat!: number;

  @ApiProperty({ example: -77.0428 })
  @Type(() => Number)
  @IsNumber()
  lon!: number;
}

/** Query del radar del carpooling (?lat=&lon=). */
export class CarpoolRadarQueryDto {
  @ApiProperty({ example: -12.0464 })
  @Type(() => Number)
  @IsNumber()
  lat!: number;

  @ApiProperty({ example: -77.0428 })
  @Type(() => Number)
  @IsNumber()
  lon!: number;
}
