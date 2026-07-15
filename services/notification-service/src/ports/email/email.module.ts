import { Module, Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { ExternalServiceError } from '@veo/utils';
import { EMAIL_SENDER, type EmailMessage, type EmailSender } from './email.port';
import type { Env } from '../../config/env.schema';

/**
 * Espeja el correo (con el OTP) al visor de OTPs de dev (dev-stack/otp-viewer) si `DEV_OTP_SINK_URL`
 * está seteada. Manda subject + html SIN tags para que el visor extraiga el código limpio (sin números
 * de CSS/atributos). Fire-and-forget: jamás rompe el envío. Solo dev — la env solo existe en development.
 */
function mirrorToDevViewer(msg: EmailMessage): Promise<unknown> {
  const sink = process.env.DEV_OTP_SINK_URL;
  if (!sink) return Promise.resolve();
  const text = `${msg.subject} — ${msg.html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()}`;
  return fetch(sink, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service: 'notification-service',
      channel: 'email',
      to: msg.to,
      message: text,
    }),
  });
}

/** Sandbox: imprime el correo (determinista) en consola. */
export class EmailSandboxSender implements EmailSender {
  private readonly logger = new Logger('EmailSandbox');
  async send(msg: EmailMessage): Promise<void> {
    this.logger.warn(`[SANDBOX EMAIL] → ${msg.to} · ${msg.subject}\n${msg.html}`);
    void mirrorToDevViewer(msg).catch((err) =>
      this.logger.debug(`[otp-viewer] no se pudo espejar el OTP (visor caído): ${err}`),
    );
  }
}

/** Live: SMTP propio vía nodemailer (Mailpit en dev). */
export class EmailSmtpSender implements EmailSender {
  constructor(
    private readonly transport: Transporter,
    private readonly from: string,
  ) {}

  async send(msg: EmailMessage): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
      });
    } catch (err) {
      throw new ExternalServiceError(`SMTP: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

const emailProvider: Provider = {
  provide: EMAIL_SENDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): EmailSender => {
    if (config.getOrThrow<string>('VEO_EMAIL_MODE') !== 'live') return new EmailSandboxSender();
    const user = config.get<string>('SMTP_USER');
    const pass = config.get<string>('SMTP_PASS');
    const transport = createTransport({
      host: config.getOrThrow<string>('SMTP_HOST'),
      port: config.getOrThrow<number>('SMTP_PORT'),
      secure: config.getOrThrow<boolean>('SMTP_SECURE'),
      auth: user && pass ? { user, pass } : undefined,
    });
    return new EmailSmtpSender(transport, config.getOrThrow<string>('SMTP_FROM'));
  },
};

@Module({ providers: [emailProvider], exports: [EMAIL_SENDER] })
export class EmailModule {}
