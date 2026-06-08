import type {AuthRepository} from '../repositories/auth-repository';
import type {OtpRequestOutcome} from '../entities';
import {isValidPeruPhone, normalizePeruPhone} from '../value-objects/phone';

/** Error de validación de entrada del flujo OTP. */
export class InvalidPhoneError extends Error {
  constructor() {
    super('Teléfono peruano inválido');
    this.name = 'InvalidPhoneError';
  }
}

/**
 * Caso de uso: solicitar el envío del OTP al conductor.
 * Normaliza y valida el teléfono antes de tocar el repositorio (depende de la abstracción).
 */
export class RequestOtpUseCase {
  constructor(private readonly auth: AuthRepository) {}

  execute(rawPhone: string): Promise<OtpRequestOutcome> {
    if (!isValidPeruPhone(rawPhone)) {
      throw new InvalidPhoneError();
    }
    const phone = normalizePeruPhone(rawPhone);
    return this.auth.requestOtp({phone, type: 'DRIVER'});
  }
}
