import { Module, Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway.port';
import { SandboxPaymentGateway } from './sandbox.gateway';
import { LivePaymentGateway } from './live.gateway';
import { ProntoPagaGateway } from './prontopaga.gateway';
import type { Env } from '../../config/env.schema';

const gatewayProvider: Provider = {
  provide: PAYMENT_GATEWAY,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): PaymentGateway => {
    const mode = config.getOrThrow<'live' | 'sandbox' | 'prontopaga'>('VEO_PAYMENT_MODE');

    if (mode === 'live') {
      Logger.log('PaymentGateway en modo LIVE (riel Yape/Plin directo)', 'PaymentGatewayModule');
      return new LivePaymentGateway({
        baseUrl: config.get<string>('PAYMENT_GATEWAY_URL') ?? '',
        apiKey: config.get<string>('PAYMENT_GATEWAY_API_KEY') ?? '',
        merchantId: config.get<string>('PAYMENT_GATEWAY_MERCHANT_ID') ?? '',
      });
    }

    if (mode === 'prontopaga') {
      // Degradación honesta: el constructor LANZA si faltan secretKey + (token|user/pass). No cobra a ciegas.
      Logger.log('PaymentGateway en modo PRONTOPAGA (agregador PE: Yape/Plin/tarjeta/PagoEfectivo)', 'PaymentGatewayModule');
      return new ProntoPagaGateway({
        baseUrl: config.getOrThrow<string>('PRONTOPAGA_BASE_URL'),
        secretKey: config.get<string>('PRONTOPAGA_SECRET_KEY') ?? '',
        apiToken: config.get<string>('PRONTOPAGA_API_TOKEN') || undefined,
        username: config.get<string>('PRONTOPAGA_USERNAME') || undefined,
        password: config.get<string>('PRONTOPAGA_PASSWORD') || undefined,
        webhookBaseUrl: config.getOrThrow<string>('PRONTOPAGA_WEBHOOK_BASE_URL'),
      });
    }

    Logger.log('PaymentGateway en modo SANDBOX (riel determinista en proceso)', 'PaymentGatewayModule');
    return new SandboxPaymentGateway({
      confirmDelayMs: config.getOrThrow<number>('SANDBOX_CONFIRM_DELAY_MS'),
      declineSuffix: config.getOrThrow<string>('SANDBOX_DECLINE_SUFFIX'),
      pendingExternal: config.getOrThrow<boolean>('SANDBOX_PENDING_EXTERNAL'),
      webhookSecret: config.getOrThrow<string>('SANDBOX_WEBHOOK_SECRET'),
    });
  },
};

@Module({ providers: [gatewayProvider], exports: [PAYMENT_GATEWAY] })
export class PaymentGatewayModule {}
