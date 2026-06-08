import { IsString, Length, Matches } from 'class-validator';

/**
 * Vinculación de teléfono al perfil (phone-link). El bff valida el formato en el borde y proxya a
 * identity-service propagando la identidad firmada; identity re-valida/normaliza con peruPhoneSchema.
 */
export class RequestPhoneLinkDto {
  @IsString()
  @Matches(/^\+?(?:51)?9\d{8}$/, { message: 'Teléfono peruano inválido' })
  phone!: string;
}

export class VerifyPhoneLinkDto {
  @IsString()
  @Matches(/^\+?(?:51)?9\d{8}$/, { message: 'Teléfono peruano inválido' })
  phone!: string;

  @IsString()
  @Length(6, 6, { message: 'El OTP tiene 6 dígitos' })
  code!: string;
}
