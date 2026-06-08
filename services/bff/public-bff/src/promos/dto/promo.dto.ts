import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, MaxLength, Min } from 'class-validator';

/** POST /promos/validate → body. Previsualiza el descuento de un cupón sobre una cotización. */
export class ValidatePromoDto {
  @ApiProperty({ description: 'Código del cupón (case-insensitive)', example: 'PRIMERVIAJE' })
  @IsString()
  @MaxLength(64)
  code!: string;

  @ApiProperty({ description: 'Bruto cotizado del viaje en céntimos PEN' })
  @IsInt()
  @Min(0)
  fareCents!: number;
}

/** Forma que el BFF devuelve (espeja `promoValidationView` de @veo/api-client). */
export interface PromoValidationView {
  code: string;
  kind: 'PERCENTAGE' | 'FIXED';
  valid: boolean;
  discountCents: number;
  reason?: string;
}
