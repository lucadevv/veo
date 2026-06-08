import { IsString, Length, Matches } from 'class-validator';

/**
 * Vinculación de teléfono al perfil del usuario autenticado (ADR-012, phone-link).
 * Mismo regex de teléfono peruano que el login OTP (auth.dto). El service re-normaliza
 * con `peruPhoneSchema` (@veo/utils) → +51XXXXXXXXX antes de tocar Redis/DB.
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
