import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/** Tokens emitidos por identity-service tras verificar el OTP. */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export class RequestOtpDto {
  @ApiProperty({
    example: '+51987654321',
    description: 'Teléfono del conductor en formato internacional',
  })
  @IsString()
  @Matches(/^\+?\d{8,15}$/, { message: 'Teléfono inválido' })
  phone!: string;
}

export class VerifyOtpDto {
  @ApiProperty({ example: '+51987654321' })
  @IsString()
  @Matches(/^\+?\d{8,15}$/, { message: 'Teléfono inválido' })
  phone!: string;

  @ApiProperty({ example: '123456', description: 'Código OTP de 4 a 6 dígitos' })
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'El OTP tiene de 4 a 6 dígitos' })
  code!: string;
}

export class RefreshDto {
  @ApiProperty({ description: 'Refresh token vigente' })
  @IsString()
  refreshToken!: string;
}

export class LogoutDto {
  @ApiProperty({ description: 'Refresh token a revocar' })
  @IsString()
  refreshToken!: string;
}
