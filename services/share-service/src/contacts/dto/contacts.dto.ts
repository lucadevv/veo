import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
