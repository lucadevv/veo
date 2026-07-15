import { isValidPeruPhone } from '../../../auth/domain';
import type { ProfileRepository } from '../repositories/profile-repository';
import type { PhoneChanged } from '../entities';

/**
 * Error de VALIDACIÓN LOCAL del número (antes de tocar la red). La UI lo muestra como error de
 * campo, no como banner de servicio (espejo del `PhoneValidationError` del pasajero).
 */
export class PhoneChangeValidationError extends Error {
  constructor() {
    super('Teléfono peruano inválido');
    this.name = 'PhoneChangeValidationError';
  }
}

/**
 * Caso de uso: pide el OTP del CAMBIO de número (semántica del dueño: el código va por SMS al número
 * NUEVO, que al verificar pasa a ser el teléfono de login). Valida el formato localmente con la MISMA
 * regla del login (`isValidPeruPhone`) para no disparar un POST con un número mal formado; identity
 * aplica el cooldown/lockout del OTP y rechaza con 409 si el número pertenece a otra cuenta.
 */
export class RequestPhoneChangeUseCase {
  constructor(private readonly repository: ProfileRepository) {}

  execute(phone: string): Promise<void> {
    if (!isValidPeruPhone(phone)) {
      return Promise.reject(new PhoneChangeValidationError());
    }
    return this.repository.requestPhoneChange(phone);
  }
}

/**
 * Caso de uso: verifica el OTP de 6 dígitos y vincula el número NUEVO. Mismos intentos/lockout que
 * el OTP de login (los aplica identity). Devuelve el teléfono ya vinculado (el próximo ingreso).
 */
export class VerifyPhoneChangeUseCase {
  constructor(private readonly repository: ProfileRepository) {}

  execute(phone: string, code: string): Promise<PhoneChanged> {
    if (!isValidPeruPhone(phone)) {
      return Promise.reject(new PhoneChangeValidationError());
    }
    return this.repository.verifyPhoneChange(phone, code);
  }
}
