import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';

export class AddContactDto {
  @ApiProperty({ example: '+51987654321', description: 'Teléfono móvil peruano del contacto' })
  @IsString()
  @Matches(/^\+?(?:51)?9\d{8}$/, { message: 'Teléfono peruano inválido' })
  phone!: string;

  @ApiProperty({ example: 'María Pérez' })
  @IsString()
  @Length(2, 80)
  name!: string;

  @ApiProperty({ example: 'madre', description: 'Parentesco / relación con el contacto' })
  @IsString()
  @Length(2, 40)
  relationship!: string;

  @ApiPropertyOptional({ example: 'maria@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;
}

export class VerifyContactOtpDto {
  @ApiProperty({ example: '123456', description: 'OTP de 6 dígitos enviado por SMS al contacto' })
  @IsString()
  @Length(6, 6, { message: 'El OTP tiene 6 dígitos' })
  code!: string;
}

/** Vista de contacto en el listado (gRPC GetTrustedContacts). */
export interface ContactView {
  id: string;
  phone: string;
  name: string;
  relationship: string;
  verified: boolean;
}

/** Recurso de contacto devuelto por share-service en los comandos REST. */
export interface ContactResource {
  id: string;
  phone: string;
  email: string | null;
  name: string;
  relationship: string;
  verified: boolean;
  createdAt: string;
}
