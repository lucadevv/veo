/**
 * DTOs del schedule de modo de pricing en el admin-bff (ADR 011 §6 · defensa en profundidad).
 * El PUT REEMPLAZA wholesale: validamos el shape completo (defaultMode + reglas) con class-validator —
 * espejo del DTO de trip-service, que RE-VALIDA aguas abajo. Mismas cotas: dayMask 1..127,
 * start/endMinute 0..1439 (minuto del día, hora local de Lima), mode ∈ { PUJA, FIXED }.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  Max,
  Min,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { BID_FLOOR_MAX_CENTS, OfferingId, PricingMode } from '@veo/shared-types';

const MODES = [PricingMode.PUJA, PricingMode.FIXED] as const;
const OFFERING_IDS = Object.values(OfferingId);

/**
 * S5 (ADR 011 · footgun overnight) — cross-field: una regla SAME-DAY exige `startMinute < endMinute`.
 * Espejo del gate de trip-service (defensa en profundidad). Una regla overnight (22:00–06:00) quedaría
 * SILENCIOSAMENTE inerte en el resolver puro (trata `end <= start` como NO-matcheante); la rechazamos
 * acá con un mensaje CLARO que enseña a partirla en dos reglas. Overnight-wrap real = follow-up.
 */
@ValidatorConstraint({ name: 'startBeforeEnd', async: false })
export class StartBeforeEndConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const rule = args.object as { startMinute?: number; endMinute?: number };
    if (typeof rule.startMinute !== 'number' || typeof rule.endMinute !== 'number') return true;
    return rule.startMinute < rule.endMinute;
  }

  defaultMessage(): string {
    return (
      'una regla no puede terminar antes o cuando empieza; para una ventana nocturna usá dos reglas: ' +
      '22:00-24:00 y 00:00-06:00'
    );
  }
}

/** Una regla horaria (día + rango en hora local de Lima). */
export class PricingModeRuleDto {
  @ApiProperty({ description: 'Bitmask de días Lun=1..Dom=64 (1..127)', minimum: 1, maximum: 127 })
  @IsInt()
  @Min(1)
  @Max(127)
  dayMask!: number;

  @ApiProperty({
    description: 'Inicio del rango, minuto del día en hora local de Lima (0..1439)',
    minimum: 0,
    maximum: 1439,
  })
  @IsInt()
  @Min(0)
  @Max(1439)
  startMinute!: number;

  @ApiProperty({
    description: 'Fin del rango, minuto del día en hora local de Lima (0..1439)',
    minimum: 0,
    maximum: 1439,
  })
  @IsInt()
  @Min(0)
  @Max(1439)
  // S5 — cross-field: el fin debe ser ESTRICTAMENTE posterior al inicio (mismo día). Ver constraint.
  @Validate(StartBeforeEndConstraint)
  endMinute!: number;

  @ApiProperty({ enum: MODES, description: 'Modo que fuerza esta regla' })
  @IsIn(MODES)
  mode!: PricingMode;
}

/** Body del PUT /pricing/mode-schedule — reemplazo wholesale del schedule. */
export class ReplaceScheduleDto {
  @ApiProperty({
    enum: MODES,
    description: 'Modo cuando ninguna regla matchea (§8.2 default PUJA)',
  })
  @IsIn(MODES)
  defaultMode!: PricingMode;

  @ApiProperty({
    type: [PricingModeRuleDto],
    description: 'Reglas en orden de evaluación (la primera que matchea gana)',
  })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PricingModeRuleDto)
  rules!: PricingModeRuleDto[];

  @ApiProperty({
    description:
      'Optimistic locking (CAS): la `version` que el panel cargó. Conflicto → 409. 0 = primer write.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

/** Techos de cordura de la tarifa base (F2.4); espejo de trip-service. */
export const BASE_FARE_MAX_CENTS = 20_000;
export const PER_KM_MAX_CENTS = 5_000;
export const PER_MIN_MAX_CENTS = 2_000;

/**
 * Body del PUT /pricing/base-fare (F2.4) — el admin reemplaza los tres componentes base de la tarifa
 * (banderazo + per-km + per-min) en céntimos PEN. Espejo del DTO de trip-service (re-valida abajo).
 */
export class ReplaceBaseFareDto {
  @ApiProperty({
    description: 'Banderazo (tarifa fija de arranque) en céntimos PEN',
    minimum: 0,
    maximum: BASE_FARE_MAX_CENTS,
  })
  @IsInt()
  @Min(0)
  @Max(BASE_FARE_MAX_CENTS)
  baseFareCents!: number;

  @ApiProperty({
    description: 'Costo por kilómetro en céntimos PEN',
    minimum: 0,
    maximum: PER_KM_MAX_CENTS,
  })
  @IsInt()
  @Min(0)
  @Max(PER_KM_MAX_CENTS)
  perKmCents!: number;

  @ApiProperty({
    description: 'Costo por minuto en céntimos PEN',
    minimum: 0,
    maximum: PER_MIN_MAX_CENTS,
  })
  @IsInt()
  @Min(0)
  @Max(PER_MIN_MAX_CENTS)
  perMinCents!: number;

  @ApiProperty({
    description:
      'Optimistic locking (CAS): la `version` que el panel cargó. trip-service reemplaza solo si sigue ' +
      'vigente; si otro admin la movió → 409. 0 = primer write.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

/** Un override del piso de la PUJA para una OFERTA. Espejo del DTO de trip-service (re-valida abajo). */
export class BidFloorOverrideDto {
  @ApiProperty({ enum: OFFERING_IDS, description: 'Oferta a la que aplica este piso' })
  @IsIn(OFFERING_IDS)
  offeringId!: OfferingId;

  @ApiProperty({
    description: 'Piso EFECTIVO de esta oferta en céntimos PEN',
    minimum: 1,
    maximum: BID_FLOOR_MAX_CENTS,
  })
  @IsInt()
  @Min(1)
  @Max(BID_FLOOR_MAX_CENTS)
  floorCents!: number;
}

/**
 * Body del PUT /pricing/bid-floor (ADR 010 §9.3) — piso de la PUJA por defecto + overrides por oferta.
 * Reemplazo wholesale; espejo del DTO de trip-service (re-valida aguas abajo).
 */
export class ReplaceBidFloorDto {
  @ApiProperty({
    description: 'Piso por defecto en céntimos PEN (sin override para la oferta)',
    minimum: 1,
    maximum: BID_FLOOR_MAX_CENTS,
  })
  @IsInt()
  @Min(1)
  @Max(BID_FLOOR_MAX_CENTS)
  defaultFloorCents!: number;

  @ApiProperty({
    type: [BidFloorOverrideDto],
    description: 'Pisos por oferta. Sin override → el default.',
  })
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => BidFloorOverrideDto)
  overrides!: BidFloorOverrideDto[];

  @ApiProperty({
    description:
      'Optimistic locking (CAS): la `version` que el panel cargó. Conflicto → 409. 0 = primer write.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
