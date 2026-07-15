import { IsString, Length, Matches } from 'class-validator';

/**
 * Cambio de teléfono del conductor (phone-link, semántica del dueño: el OTP va al número NUEVO y ese
 * número pasa a ser el de login). Mismo contrato/regex que el public-bff (`users/dto/phone-link.dto.ts`,
 * para no divergir entre BFFs); identity re-normaliza con `peruPhoneSchema` antes de tocar Redis/DB.
 */
export class RequestPhoneChangeDto {
  @IsString()
  @Matches(/^\+?(?:51)?9\d{8}$/, { message: 'Teléfono peruano inválido' })
  phone!: string;
}

export class VerifyPhoneChangeDto {
  @IsString()
  @Matches(/^\+?(?:51)?9\d{8}$/, { message: 'Teléfono peruano inválido' })
  phone!: string;

  @IsString()
  @Length(6, 6, { message: 'El OTP tiene 6 dígitos' })
  code!: string;
}

/** Respuesta de POST /drivers/me/phone/request: el OTP salió por SMS al número NUEVO. */
export interface PhoneChangeRequested {
  sent: true;
}

/**
 * Respuesta de POST /drivers/me/phone/verify. identity devuelve su ProfileView completo (shape del
 * pasajero, con campos passenger-only); el driver-bff lo PROYECTA a lo único que la app del conductor
 * necesita: el teléfono ya vinculado (que desde ahora es el de login).
 */
export interface PhoneChangeResult {
  phone: string | null;
}

/** Respuesta 202 de POST /drivers/me/deletion: inicio de la gracia del derecho al olvido. */
export interface DeletionRequested {
  graceUntil: string;
}
