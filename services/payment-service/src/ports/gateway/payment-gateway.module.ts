import { Module, Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertNever } from '@veo/utils';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway.port';
import { SandboxPaymentGateway } from './sandbox.gateway';
import { LivePaymentGateway } from './live.gateway';
import { ProntoPagaGateway } from './prontopaga.gateway';
import type { Env } from '../../config/env.schema';

/** Modos válidos del puerto = los del env schema (z.enum). Una sola fuente de verdad. */
type PaymentMode = Env['VEO_PAYMENT_MODE'];

const gatewayProvider: Provider = {
  provide: PAYMENT_GATEWAY,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): PaymentGateway => {
    // El env schema ya valida VEO_PAYMENT_MODE como z.enum al boot (validateEnv), así que un valor
    // fuera del catálogo NO debería llegar acá. Igual el switch es EXHAUSTIVO sin default silencioso
    // (defensa en profundidad): agregar un proveedor al enum OBLIGA al compilador a exigir su rama,
    // y un valor no contemplado en runtime (schema bypasseado/desincronizado) ABORTA el boot con
    // mensaje accionable en vez de cobrar por el adapter equivocado.
    const mode = config.getOrThrow<PaymentMode>('VEO_PAYMENT_MODE');

    switch (mode) {
      case 'live':
        Logger.log('PaymentGateway en modo LIVE (riel Yape/Plin directo)', 'PaymentGatewayModule');
        return new LivePaymentGateway({
          baseUrl: config.get<string>('PAYMENT_GATEWAY_URL') ?? '',
          apiKey: config.get<string>('PAYMENT_GATEWAY_API_KEY') ?? '',
          merchantId: config.get<string>('PAYMENT_GATEWAY_MERCHANT_ID') ?? '',
        });

      case 'prontopaga':
        // Degradación honesta: el constructor LANZA si faltan secretKey + (token|user/pass). No cobra a ciegas.
        Logger.log(
          'PaymentGateway en modo PRONTOPAGA (agregador PE: Yape/Plin/tarjeta/PagoEfectivo)',
          'PaymentGatewayModule',
        );
        return new ProntoPagaGateway({
          baseUrl: config.getOrThrow<string>('PRONTOPAGA_BASE_URL'),
          secretKey: config.get<string>('PRONTOPAGA_SECRET_KEY') ?? '',
          apiToken: config.get<string>('PRONTOPAGA_API_TOKEN') || undefined,
          username: config.get<string>('PRONTOPAGA_USERNAME') || undefined,
          password: config.get<string>('PRONTOPAGA_PASSWORD') || undefined,
          webhookBaseUrl: config.getOrThrow<string>('PRONTOPAGA_WEBHOOK_BASE_URL'),
        });

      case 'sandbox':
        Logger.log(
          'PaymentGateway en modo SANDBOX (riel determinista en proceso)',
          'PaymentGatewayModule',
        );
        return new SandboxPaymentGateway({
          confirmDelayMs: config.getOrThrow<number>('SANDBOX_CONFIRM_DELAY_MS'),
          declineSuffix: config.getOrThrow<string>('SANDBOX_DECLINE_SUFFIX'),
          pendingExternal: config.getOrThrow<boolean>('SANDBOX_PENDING_EXTERNAL'),
          webhookSecret: config.getOrThrow<string>('SANDBOX_WEBHOOK_SECRET'),
        });

      default:
        return assertNever(
          mode,
          'VEO_PAYMENT_MODE no contemplado (esperado: live | sandbox | prontopaga). ' +
            'Si agregaste un proveedor: sumá el modo al z.enum de config/env.schema.ts y su rama en esta factory',
        );
    }
  },
};

@Module({ providers: [gatewayProvider], exports: [PAYMENT_GATEWAY] })
export class PaymentGatewayModule {}
