import { Module, Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertNever } from '@veo/utils';
import { PAYOUT_GATEWAY, type PayoutGateway } from './payout-gateway.port';
import { SandboxPayoutGateway } from './sandbox-payout.gateway';
import { YapePlinPayoutGateway } from './yape-plin-payout.gateway';
import type { Env } from '../../config/env.schema';

/** Modos válidos del puerto money-OUT = los del env schema (z.enum). Una sola fuente de verdad. */
type PayoutMode = Env['PAYOUT_GATEWAY_MODE'];

const payoutGatewayProvider: Provider = {
  provide: PAYOUT_GATEWAY,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): PayoutGateway => {
    // ESPEJO de la factory del PaymentGateway (money-IN): el env schema ya valida PAYOUT_GATEWAY_MODE
    // como z.enum al boot, así que un valor fuera del catálogo no debería llegar. El switch es EXHAUSTIVO
    // sin default silencioso (defensa en profundidad): agregar un modo OBLIGA al compilador a exigir su rama.
    const mode = config.getOrThrow<PayoutMode>('PAYOUT_GATEWAY_MODE');

    switch (mode) {
      case 'live':
        Logger.log(
          'PayoutGateway en modo LIVE (riel Yape/Plin desembolso — DIFERIDO, convenio PSP)',
          'PayoutGatewayModule',
        );
        return new YapePlinPayoutGateway({
          baseUrl: config.get<string>('PAYOUT_GATEWAY_URL') ?? '',
          apiKey: config.get<string>('PAYOUT_GATEWAY_API_KEY') ?? '',
          merchantId: config.get<string>('PAYOUT_GATEWAY_MERCHANT_ID') ?? '',
        });

      case 'sandbox':
        Logger.log(
          'PayoutGateway en modo SANDBOX (riel de desembolso determinista en proceso)',
          'PayoutGatewayModule',
        );
        return new SandboxPayoutGateway({
          rejectSeed: config.getOrThrow<number>('SANDBOX_PAYOUT_REJECT_SEED'),
          confirmSync: config.getOrThrow<boolean>('SANDBOX_PAYOUT_CONFIRM_SYNC'),
        });

      default:
        return assertNever(
          mode,
          'PAYOUT_GATEWAY_MODE no contemplado (esperado: live | sandbox). ' +
            'Si agregaste un proveedor: sumá el modo al z.enum de config/env.schema.ts y su rama en esta factory',
        );
    }
  },
};

@Module({ providers: [payoutGatewayProvider], exports: [PAYOUT_GATEWAY] })
export class PayoutGatewayModule {}
