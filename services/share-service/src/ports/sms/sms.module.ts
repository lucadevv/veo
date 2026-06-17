import { Module, Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalServiceError } from '@veo/utils';
import { SMS_SENDER, type SmsSender } from './sms.port';
import type { Env } from '../../config/env.schema';

/** Enmascara un teléfono dejando solo los últimos 4 dígitos (PII §0.7): +51•••••4321 → "•••4321". */
function maskPhone(to: string): string {
  const tail = to.replace(/\D/g, '').slice(-4);
  return tail ? `•••${tail}` : '•••';
}

/**
 * Sandbox: no envía nada real. NO loguea el cuerpo (puede traer OTP/enlace) ni el teléfono completo:
 * solo destino enmascarado + longitud del mensaje. Soberanía §0.7: cero PII en logs.
 */
class SmsSandboxSender implements SmsSender {
  private readonly logger = new Logger('SmsSandbox');
  async send(to: string, message: string): Promise<void> {
    this.logger.warn(`[SANDBOX SMS] → ${maskPhone(to)} (${message.length} chars)`);
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
