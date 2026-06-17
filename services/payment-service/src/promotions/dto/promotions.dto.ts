import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, MaxLength, Min } from 'class-validator';

/** POST /promotions/validate → body (previsualización del descuento sobre una cotización). */
export class ValidatePromoDto {
  @ApiProperty({ description: 'Código del cupón (case-insensitive)', example: 'PRIMERVIAJE' })
  @IsString()
  @MaxLength(64)
  code!: string;

  @ApiProperty({ description: 'Id del usuario (lo fija el BFF desde la identidad)' })
  @IsString()
  userId!: string;

  @ApiProperty({ description: 'Bruto cotizado del viaje en céntimos PEN' })
  @IsInt()
  @Min(0)
  fareCents!: number;
}

/** POST /promotions/redeem → body (canje idempotente al cobrar). */
export class RedeemPromoDto {
  @ApiProperty({ example: 'PRIMERVIAJE' })
  @IsString()
  @MaxLength(64)
  code!: string;

  @ApiProperty()
  @IsString()
  userId!: string;

  @ApiProperty()
  @IsString()
  tripId!: string;

  @ApiProperty({ description: 'Bruto del viaje en céntimos PEN' })
  @IsInt()
  @Min(0)
  fareCents!: number;

  @ApiProperty({ description: 'Clave de idempotencia del canje' })
  @IsString()
  @MaxLength(128)
  dedupKey!: string;
}

/** Vista de validación devuelta al BFF/app. */
export interface PromoValidationView {
  code: string;
  kind: 'PERCENTAGE' | 'FIXED';
  valid: boolean;
  discountCents: number;
  reason?: string;
}

/** Vista de canje devuelta al BFF. */
export interface PromoRedemptionView {
  redemptionId: string;
  promotionId: string;
  code: string;
  discountCents: number;
}
