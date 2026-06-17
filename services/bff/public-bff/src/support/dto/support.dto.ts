import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export const SUPPORT_CATEGORIES = [
  'TRIP',
  'PAYMENT',
  'ACCOUNT',
  'SAFETY',
  'DRIVER',
  'OTHER',
] as const;
export type SupportCategoryValue = (typeof SUPPORT_CATEGORIES)[number];

/** POST /support/tickets → body. El BFF fija userId/role desde la identidad del pasajero. */
export class CreateTicketDto {
  @ApiProperty({ enum: SUPPORT_CATEGORIES })
  @IsIn(SUPPORT_CATEGORIES)
  category!: SupportCategoryValue;

  @ApiProperty({ minLength: 3, maxLength: 160 })
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  subject!: string;

  @ApiProperty({ minLength: 1, maxLength: 4000 })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;

  @ApiPropertyOptional({ description: 'Viaje relacionado (UUID)' })
  @IsOptional()
  @IsUUID()
  tripId?: string;
}
