/**
 * DTO de la tarifa base GLOBAL de pricing (F2.4). El PUT REEMPLAZA wholesale (banderazo + per-km + per-min)
 * con class-validator. ADR 023: el schedule/franjas de modo (ADR 011) se retiró; el modo vive por oferta.
 */
import { IsInt, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

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
