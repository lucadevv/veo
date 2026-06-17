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

  @ApiProperty({ description: 'Inicio del rango, minuto del día en hora local de Lima (0..1439)', minimum: 0, maximum: 1439 })
  @IsInt()
  @Min(0)
  @Max(1439)
  startMinute!: number;

  @ApiProperty({ description: 'Fin del rango, minuto del día en hora local de Lima (0..1439)', minimum: 0, maximum: 1439 })
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
  @ApiProperty({ enum: MODES, description: 'Modo cuando ninguna regla matchea (§8.2 default PUJA)' })
  @IsIn(MODES)
  defaultMode!: PricingMode;

  @ApiProperty({ type: [PricingModeRuleDto], description: 'Reglas en orden de evaluación (la primera que matchea gana)' })
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

/** Techos de cordura: precio S/100/L y rendimiento 200 km/L (evitan un dedazo catastrófico del admin). */
export const FUEL_PRICE_MAX_CENTS_PER_LITER = 10_000;
export const FUEL_KM_PER_LITER_MAX = 200;

/**
 * Body del PUT /internal/pricing/fuel-surcharge (B4) — el admin ingresa el PRECIO del combustible (lo que
 * ve en el grifo) + el RENDIMIENTO (km/litro); el server deriva el recargo/km = precio ÷ rendimiento.
 */
export class ReplaceFuelSurchargeDto {
  @ApiProperty({
    description: 'Precio del combustible por litro en céntimos PEN (0 = sin recargo)',
    minimum: 0,
    maximum: FUEL_PRICE_MAX_CENTS_PER_LITER,
  })
  @IsInt()
  @Min(0)
  @Max(FUEL_PRICE_MAX_CENTS_PER_LITER)
  fuelPricePerLiterCents!: number;

  @ApiProperty({
    description: 'Rendimiento del vehículo de referencia en km por litro (1..200; 0 = sin recargo)',
    minimum: 0,
    maximum: FUEL_KM_PER_LITER_MAX,
  })
  @IsInt()
  @Min(0)
  @Max(FUEL_KM_PER_LITER_MAX)
  kmPerLiter!: number;

  @ApiProperty({
    description:
      'Optimistic locking: la `version` que el cliente cargó. El server REEMPLAZA solo si la versión ' +
      'vigente sigue siendo esta (CAS); si otro admin cambió el config mientras tanto → 409 ConflictError. ' +
      '0 = el cliente no vio ninguna fila (primer write).',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
