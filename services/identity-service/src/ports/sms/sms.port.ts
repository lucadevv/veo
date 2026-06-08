/**
 * Puerto SMS (FOUNDATION §9). Riel externo (operador) tras puerto propio intercambiable.
 * Default dev: sandbox (imprime el OTP en consola).
 */
export const SMS_SENDER = Symbol('SMS_SENDER');

export interface SmsSender {
  send(to: string, message: string): Promise<void>;
}
