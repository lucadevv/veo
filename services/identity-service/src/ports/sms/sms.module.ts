import { Module, Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalServiceError } from '@veo/utils';
import { SMS_SENDER, type SmsSender } from './sms.port';
import type { Env } from '../../config/env.schema';

/**
 * Espeja el mensaje (con el OTP en claro) al visor de OTPs de dev (dev-stack/otp-viewer) si
 * `DEV_OTP_SINK_URL` está seteada. Fire-and-forget: jamás rompe el envío. Solo dev — la env solo
 * existe en development; en prod no está y esto es no-op.
 */
function mirrorToDevViewer(to: string, message: string): Promise<unknown> {
  const sink = process.env.DEV_OTP_SINK_URL;
  if (!sink) return Promise.resolve();
  return fetch(sink, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service: 'identity-service', channel: 'sms', to, message }),
  });
}

/** Sandbox: no envía nada real; imprime el mensaje (incluido el OTP) en el log de la consola. */
class SmsSandboxSender implements SmsSender {
  private readonly logger = new Logger('SmsSandbox');
  async send(to: string, message: string): Promise<void> {
    this.logger.warn(`[SANDBOX SMS] → ${to}: ${message}`);
    void mirrorToDevViewer(to, message).catch((err) =>
      this.logger.debug(`[otp-viewer] no se pudo espejar el OTP (visor caído): ${err}`),
    );
  }
}

/**
 * Live: conector mínimo al operador celular (placeholder hasta tener convenio/gateway propio).
 * Implementar el POST al gateway del operador aquí. Lanza hasta entonces para no fallar en silencio.
 */
class SmsOperatorSender implements SmsSender {
  async send(_to: string, _message: string): Promise<void> {
    throw new ExternalServiceError(
      'SMS en modo live aún no configurado (falta gateway de operador)',
    );
  }
}

const smsProvider: Provider = {
  provide: SMS_SENDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): SmsSender =>
    config.getOrThrow<string>('VEO_SMS_MODE') === 'live'
      ? new SmsOperatorSender()
      : new SmsSandboxSender(),
};

@Module({ providers: [smsProvider], exports: [SMS_SENDER] })
export class SmsModule {}
