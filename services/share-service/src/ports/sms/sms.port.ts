/**
 * Puerto SMS (FOUNDATION §9). Riel externo (operador) tras puerto propio intercambiable.
 * Lo usan: el OTP de verificación de contactos y el envío del enlace de seguimiento en pánico.
 * Default dev: sandbox (imprime el mensaje, incluido el OTP/enlace, en consola).
 */
export const SMS_SENDER = Symbol('SMS_SENDER');

export interface SmsSender {
  send(to: string, message: string): Promise<void>;
}
