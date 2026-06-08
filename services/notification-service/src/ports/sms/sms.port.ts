/**
 * Puerto SMS (FOUNDATION §9). Riel externo (operador celular) tras puerto propio intercambiable.
 * Live: SMPP 3.4 directo al operador (NO Twilio). Sandbox: imprime el SMS en consola.
 * Selección por VEO_SMS_MODE.
 */
export const SMS_SENDER = Symbol('SMS_SENDER');

export interface SmsSender {
  send(to: string, message: string): Promise<void>;
}
