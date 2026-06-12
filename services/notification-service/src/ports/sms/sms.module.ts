import { Module, Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalServiceError } from '@veo/utils';
import { SMS_SENDER, type SmsSender } from './sms.port';
import { SmppClient } from './smpp-client';
import type { Env } from '../../config/env.schema';

/** Enmascara un teléfono dejando solo los últimos 4 dígitos (PII §0.7). */
function maskPhone(to: string): string {
  const tail = to.replace(/\D/g, '').slice(-4);
  return tail ? `•••${tail}` : '•••';
}

/**
 * Sandbox: no envía nada real. NO loguea el cuerpo (puede traer enlace/datos del pasajero) ni el
 * teléfono completo: solo destino enmascarado + longitud. Soberanía §0.7: cero PII en logs.
 */
export class SmsSandboxSender implements SmsSender {
  private readonly logger = new Logger('SmsSandbox');
  async send(to: string, message: string): Promise<void> {
    this.logger.warn(`[SANDBOX SMS] → ${maskPhone(to)} (${message.length} chars)`);
  }
}

/** Live: SMPP 3.4 directo al operador celular. */
export class SmsSmppSender implements SmsSender {
  constructor(private readonly client: SmppClient) {}
  async send(to: string, message: string): Promise<void> {
    await this.client.send(to, message);
  }
}

const smsProvider: Provider = {
  provide: SMS_SENDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): SmsSender => {
    if (config.getOrThrow<string>('VEO_SMS_MODE') !== 'live') return new SmsSandboxSender();
    const host = config.get<string>('SMPP_HOST');
    const systemId = config.get<string>('SMPP_SYSTEM_ID');
    const password = config.get<string>('SMPP_PASSWORD');
    if (!host || !systemId || !password) {
      throw new ExternalServiceError('SMS live: faltan SMPP_HOST / SMPP_SYSTEM_ID / SMPP_PASSWORD');
    }
    return new SmsSmppSender(
      new SmppClient({
        host,
        port: config.getOrThrow<number>('SMPP_PORT'),
        systemId,
        password,
        sourceAddr: config.getOrThrow<string>('SMPP_SOURCE_ADDR'),
        timeoutMs: config.getOrThrow<number>('SMPP_TIMEOUT_MS'),
      }),
    );
  },
};

@Module({ providers: [smsProvider], exports: [SMS_SENDER] })
export class SmsModule {}
