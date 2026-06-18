import { Module, Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalServiceError } from '@veo/utils';
import { SMS_SENDER, SmsProvider, type SmsSender } from './sms.port';
import { SmppClient } from './smpp-client';
import { TwilioSmsSender } from './twilio-client';
import { WhatsAppCloudSender } from './whatsapp-client';
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

/** Fábrica de un adapter SMS a partir de la config. Cada proveedor valida fail-fast sus credenciales. */
type SmsProviderFactory = (config: ConfigService<Env, true>) => SmsSender;

function buildSmpp(config: ConfigService<Env, true>): SmsSender {
  const host = config.get<string>('SMPP_HOST');
  const systemId = config.get<string>('SMPP_SYSTEM_ID');
  const password = config.get<string>('SMPP_PASSWORD');
  if (!host || !systemId || !password) {
    throw new ExternalServiceError('SMS smpp: faltan SMPP_HOST / SMPP_SYSTEM_ID / SMPP_PASSWORD');
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
}

function buildTwilio(config: ConfigService<Env, true>): SmsSender {
  const accountSid = config.get<string>('TWILIO_ACCOUNT_SID');
  const authToken = config.get<string>('TWILIO_AUTH_TOKEN');
  const from = config.get<string>('TWILIO_FROM');
  const messagingServiceSid = config.get<string>('TWILIO_MESSAGING_SERVICE_SID');
  if (!accountSid || !authToken) {
    throw new ExternalServiceError('SMS twilio: faltan TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN');
  }
  // From y MessagingServiceSid son EXCLUYENTES: exactamente uno (fail-fast como hace SMPP).
  if (Boolean(from) === Boolean(messagingServiceSid)) {
    throw new ExternalServiceError(
      'SMS twilio: definir EXACTAMENTE uno de TWILIO_FROM / TWILIO_MESSAGING_SERVICE_SID',
    );
  }
  return new TwilioSmsSender({
    accountSid,
    authToken,
    ...(from ? { from } : {}),
    ...(messagingServiceSid ? { messagingServiceSid } : {}),
    timeoutMs: config.getOrThrow<number>('TWILIO_TIMEOUT_MS'),
  });
}

function buildWhatsApp(config: ConfigService<Env, true>): SmsSender {
  const phoneNumberId = config.get<string>('WHATSAPP_PHONE_NUMBER_ID');
  const accessToken = config.get<string>('WHATSAPP_ACCESS_TOKEN');
  const otpTemplate = config.get<string>('WHATSAPP_OTP_TEMPLATE');
  if (!phoneNumberId || !accessToken || !otpTemplate) {
    throw new ExternalServiceError(
      'SMS whatsapp: faltan WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN / WHATSAPP_OTP_TEMPLATE',
    );
  }
  return new WhatsAppCloudSender({
    phoneNumberId,
    accessToken,
    otpTemplate,
    otpLang: config.getOrThrow<string>('WHATSAPP_OTP_LANG'),
    graphVersion: config.getOrThrow<string>('WHATSAPP_GRAPH_VERSION'),
    timeoutMs: config.getOrThrow<number>('WHATSAPP_TIMEOUT_MS'),
  });
}

/**
 * REGISTRY proveedor→fábrica. ESTE es el único punto de extensión (OCP): agregar un proveedor =
 * un adapter nuevo + UNA entrada acá. Los adapters existentes y los llamadores NO se tocan.
 */
const SMS_REGISTRY: Readonly<Record<SmsProvider, SmsProviderFactory>> = {
  [SmsProvider.Sandbox]: () => new SmsSandboxSender(),
  [SmsProvider.Smpp]: buildSmpp,
  [SmsProvider.Twilio]: buildTwilio,
  [SmsProvider.WhatsApp]: buildWhatsApp,
};

/**
 * Resuelve el proveedor seleccionado con BACKWARD-COMPAT del flag legado `VEO_SMS_MODE`:
 *  - Si `SMS_PROVIDER` está definido, manda (fuente única nueva).
 *  - Si no, se deriva del legado: VEO_SMS_MODE=live → smpp; resto → sandbox (comportamiento previo).
 */
function resolveProvider(config: ConfigService<Env, true>): SmsProvider {
  const explicit = config.get<SmsProvider>('SMS_PROVIDER');
  if (explicit) return explicit;
  return config.getOrThrow<string>('VEO_SMS_MODE') === 'live' ? SmsProvider.Smpp : SmsProvider.Sandbox;
}

const smsProvider: Provider = {
  provide: SMS_SENDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): SmsSender => {
    const provider = resolveProvider(config);
    const logger = new Logger('SmsModule');
    logger.log(`SMS provider seleccionado: ${provider}`);
    return SMS_REGISTRY[provider](config);
  },
};

@Module({ providers: [smsProvider], exports: [SMS_SENDER] })
export class SmsModule {}
