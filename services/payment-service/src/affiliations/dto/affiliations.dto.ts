import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';

/** Tipos de documento aceptados por ProntoPaga en Perú. */
const DOC_TYPES = ['DN', 'CE', 'PP'] as const;

export class CreateYapeAffiliationDto {
  @ApiPropertyOptional({
    description: 'Teléfono Yape (solo dígitos). SOLO en origin=WEB; en MOBILE se omite.',
    example: '999881234',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6,15}$/, { message: 'phone debe ser solo dígitos (6-15)' })
  phone?: string;

  @ApiProperty({ description: 'Número de documento de identidad', example: '12345678' })
  @IsString()
  @Length(6, 20)
  document!: string;

  @ApiProperty({ enum: DOC_TYPES, description: 'Tipo de documento (DN|CE|PP)' })
  @IsEnum(Object.fromEntries(DOC_TYPES.map((d) => [d, d])))
  documentType!: (typeof DOC_TYPES)[number];

  @ApiProperty({ description: 'Nombre completo del cliente', example: 'Juan Perez' })
  @IsString()
  @Length(2, 200)
  clientName!: string;

  @ApiPropertyOptional({ enum: ['WEB', 'MOBILE'], description: 'Origen del cliente (default MOBILE)' })
  @IsOptional()
  @IsEnum({ WEB: 'WEB', MOBILE: 'MOBILE' })
  origin?: 'WEB' | 'MOBILE';
}
