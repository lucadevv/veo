import { Module, Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { ExternalServiceError } from '@veo/utils';
import { EMAIL_SENDER, type EmailMessage, type EmailSender } from './email.port';
import type { Env } from '../../config/env.schema';

/** Sandbox: imprime el correo (determinista) en consola. */
export class EmailSandboxSender implements EmailSender {
  private readonly logger = new Logger('EmailSandbox');
  async send(msg: EmailMessage): Promise<void> {
    this.logger.warn(`[SANDBOX EMAIL] → ${msg.to} · ${msg.subject}\n${msg.html}`);
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
