/**
 * DTOs del schedule de modo de pricing (ADR 011). El PUT REEMPLAZA wholesale: validamos el shape
 * completo (defaultMode + reglas) con class-validator, espejo del payload pricing.mode_schedule_updated.
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
import { PricingMode } from '@veo/shared-types';

const MODES = [PricingMode.PUJA, PricingMode.FIXED] as const;

/**
 * S5 (ADR 011 · footgun overnight) — cross-field: una regla SAME-DAY exige `startMinute < endMinute`.
 * El resolver puro trata `end <= start` como NO-matcheante (rangos overnight no soportados en el MVP),
 * así que una regla 22:00–06:00 quedaría SILENCIOSAMENTE inerte sin este gate. Lo rechazamos con un
 * mensaje CLARO que enseña el workaround (partir la ventana nocturna en dos reglas). Overnight-wrap real
 * = follow-up no-breaking. Se valida acá Y en admin-bff (defensa en profundidad).
 */
@ValidatorConstraint({ name: 'startBeforeEnd', async: false })
export class StartBeforeEndConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const rule = args.object as { startMinute?: number; endMinute?: number };
    // Solo opinamos cuando ambos son números (los @IsInt/@Min/@Max ya reportan los tipos inválidos).
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

/** Body del PUT /internal/pricing/mode-schedule — reemplazo wholesale del schedule. */
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
      'Optimistic locking (CAS): la `version` que el panel cargó. Se reemplaza solo si sigue vigente; ' +
      'si otro admin la movió → 409. 0 = primer write.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

/**
 * Techos de cordura de la tarifa base (F2.4) en céntimos PEN — evitan un dedazo catastrófico del admin.
 * Banderazo S/200, S/50/km, S/20/min: holgados sobre los valores vigentes (S/6 · S/1.20 · S/0.30).
 */
export const BASE_FARE_MAX_CENTS = 20_000;
export const PER_KM_MAX_CENTS = 5_000;
export const PER_MIN_MAX_CENTS = 2_000;

/**
 * Body del PUT /internal/pricing/base-fare (F2.4) — el admin reemplaza los tres componentes base de la
 * tarifa (banderazo + per-km + per-min) en céntimos PEN. Dinero SIEMPRE Int, nunca float.
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
      'Optimistic locking (CAS): la `version` que el cliente cargó. El server REEMPLAZA solo si la versión ' +
      'vigente sigue siendo esta; si otro admin la movió → 409 ConflictError. 0 = primer write.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
