import { Module, Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SMS_SENDER, type SmsSender } from './sms.port';
import { NotificationSmsSender } from './notification-sms-sender';
import { LIVE_MODE, type Env } from '../../config/env.schema';

/** Enmascara un teléfono dejando solo los últimos 4 dígitos (PII §0.7): +51•••••4321 → "•••4321". */
function maskPhone(to: string): string {
  const tail = to.replace(/\D/g, '').slice(-4);
  return tail ? `•••${tail}` : '•••';
}

/**
 * Espeja el mensaje (con el OTP en claro) al visor de OTPs de dev (dev-stack/otp-viewer) si
 * `DEV_OTP_SINK_URL` está seteada. Fire-and-forget: jamás rompe el envío. Solo dev — la env solo
 * existe en development; en prod no está y esto es no-op. NO afecta la regla de logs (acá sí va el
 * cuerpo, pero al visor efímero de dev, no a los logs persistentes — soberanía §0.7 intacta).
 */
function mirrorToDevViewer(to: string, message: string): Promise<unknown> {
  const sink = process.env.DEV_OTP_SINK_URL;
  if (!sink) return Promise.resolve();
  return fetch(sink, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service: 'share-service', channel: 'sms', to, message }),
  });
}

/**
 * Sandbox: no envía nada real. NO loguea el cuerpo (puede traer OTP/enlace) ni el teléfono completo:
 * solo destino enmascarado + longitud del mensaje. Soberanía §0.7: cero PII en logs.
 */
class SmsSandboxSender implements SmsSender {
  private readonly logger = new Logger('SmsSandbox');
  async send(to: string, message: string): Promise<void> {
    this.logger.warn(`[SANDBOX SMS] → ${maskPhone(to)} (${message.length} chars)`);
    void mirrorToDevViewer(to, message).catch((err) =>
      this.logger.debug(`[otp-viewer] no se pudo espejar el OTP (visor caído): ${err}`),
    );
  }
}

/**
 * Live: delega la entrega del OTP a notification-service (su motor propio: dedup + retry + routing
 * por canal) vía el cliente REST interno FIRMADO. Reusa la plantilla `contact.otp` y pasa el código
 * estructurado en `payload.code`. Ver NotificationSmsSender. El throw del placeholder de operador
 * quedó atrás. (El enlace de pánico BR-S05 NO usa este puerto: va por outbox → notification fan-out.)
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
    config.getOrThrow<string>('VEO_SMS_MODE') === LIVE_MODE
      ? buildLiveSender(config)
      : new SmsSandboxSender(),
};

@Module({ providers: [smsProvider], exports: [SMS_SENDER] })
export class SmsModule {}
