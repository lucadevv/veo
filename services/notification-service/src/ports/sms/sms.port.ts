/**
 * Puerto SMS (FOUNDATION §9). Riel externo (operador celular / agregador) tras puerto propio
 * intercambiable. La selección del proveedor concreto vive en un REGISTRY (`Map` provider→factory)
 * resuelto por `SMS_PROVIDER` — agregar un proveedor = un adapter nuevo + UNA entrada (OCP), sin tocar
 * los adapters ni los llamadores existentes.
 *
 * Convención del subsistema (igual que PUSH): los DISCRIMINANTES de dominio son objetos `as const` con
 * su tipo derivado — NUNCA string literals sueltos. Fuente única, autocompletado, refactor-safe y
 * comparaciones `=== SmsProvider.Twilio` (no `=== 'twilio'`).
 */
export const SMS_SENDER = Symbol('SMS_SENDER');

/**
 * Proveedor SMS concreto seleccionable por config (`SMS_PROVIDER`).
 *  - Sandbox: log determinista en consola (default LOCAL, cero PII).
 *  - Smpp: SMPP 3.4 directo al operador (implementación propia sobre TCP).
 *  - Twilio: SMS por la REST API de Twilio (raw fetch, sin SDK).
 *  - WhatsApp: OTP por WhatsApp Cloud API (Meta Graph), plantilla de autenticación pre-aprobada.
 */
export const SmsProvider = {
  Sandbox: 'sandbox',
  Smpp: 'smpp',
  Twilio: 'twilio',
  WhatsApp: 'whatsapp',
} as const;
export type SmsProvider = (typeof SmsProvider)[keyof typeof SmsProvider];

export interface SmsSender {
  send(to: string, message: string): Promise<void>;
}
