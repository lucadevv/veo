/**
 * Puerto EMAIL (FOUNDATION §9, ADR-012). SMTP propio vía nodemailer. Dev → Mailpit (localhost:1025).
 * Sandbox: imprime el correo en consola. Selección por VEO_EMAIL_MODE.
 * El dominio (AuthService) depende de ESTE Symbol, nunca de nodemailer.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
}
