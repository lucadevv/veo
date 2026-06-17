import type { AuthRepository } from '../repositories/auth-repository';
import type { AuthTokens } from '../entities';
import { normalizePeruPhone } from '../value-objects/phone';

/** Error de validación del código OTP (6 dígitos). */
export class InvalidOtpCodeError extends Error {
  constructor() {
    super('El código OTP debe tener 6 dígitos');
    this.name = 'InvalidOtpCodeError';
  }
}

const OTP_CODE = /^\d{6}$/;

/**
 * Caso de uso: verificar el OTP y obtener los tokens del conductor.
 * Devuelve solo tokens; la composición de la sesión (perfil + persistencia) la hace `LoginUseCase`.
 */
export class VerifyOtpUseCase {
  constructor(private readonly auth: AuthRepository) {}

  execute(rawPhone: string, code: string): Promise<AuthTokens> {
    if (!OTP_CODE.test(code)) {
      throw new InvalidOtpCodeError();
    }
    const phone = normalizePeruPhone(rawPhone);
    return this.auth.verifyOtp({ phone, code, type: 'DRIVER' });
  }
}
