import { Module, Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SMS_SENDER, type SmsSender } from './sms.port';
import { NotificationSmsSender } from './notification-sms-sender';
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
 * Live: delega la entrega del OTP a notification-service (su motor propio: dedup + retry + routing
 * por canal, con los proveedores reales SMS/WhatsApp del LOTE 1) vía el cliente REST interno FIRMADO.
 * Reusa la plantilla `contact.otp` y pasa el código estructurado en `payload.code`. Ver
 * NotificationSmsSender. El throw del placeholder de operador quedó atrás.
 */
function buildLiveSender(config: ConfigService<Env, true>): SmsSender {
  // Fail-fast: si está en modo live pero falta la URL de notification, el servicio NO arranca
  // (mejor que descubrirlo en el primer OTP). getOrThrow ya valida presencia vía el schema.
  const baseUrl = config.getOrThrow<string>('NOTIFICATION_INTERNAL_URL');
  const secret = config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET');
  const timeoutMs = config.getOrThrow<number>('NOTIFICATION_TIMEOUT_MS');
  return new NotificationSmsSender(baseUrl, secret, timeoutMs);
}

const smsProvider: Provider = {
  provide: SMS_SENDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): SmsSender =>
    config.getOrThrow<string>('VEO_SMS_MODE') === 'live'
      ? buildLiveSender(config)
      : new SmsSandboxSender(),
};

@Module({ providers: [smsProvider], exports: [SMS_SENDER] })
export class SmsModule {}
