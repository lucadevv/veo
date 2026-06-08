/**
 * Orquestación del webhook de ProntoPaga: verifica la firma con el adapter activo y enruta.
 *  - kind 'payment'     → PaymentsService.applyWebhookResult (transición idempotente del Payment).
 *  - kind 'affiliation' → AffiliationsService.markFromWebhook (ACTIVE/EXPIRED).
 *
 * La verificación de firma vive en el ADAPTER (sandbox o prontopaga) vía la capacidad WebhookVerifier.
 * Si el modo activo no verifica webhooks (live), respondemos 401 (no aceptamos webhooks no verificables).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { UnauthorizedError } from '@veo/utils';
import {
  PAYMENT_GATEWAY,
  supportsWebhooks,
  type PaymentGateway,
} from '../ports/gateway/payment-gateway.port';
import { PaymentsService } from '../payments/payments.service';
import { AffiliationsService } from '../affiliations/affiliations.service';

@Injectable()
export class ProntoPagaWebhookService {
  private readonly logger = new Logger(ProntoPagaWebhookService.name);

  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly payments: PaymentsService,
    private readonly affiliations: AffiliationsService,
  ) {}

  async process(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<void> {
    if (!supportsWebhooks(this.gateway)) {
      // El gateway activo (live) no verifica webhooks: no aceptamos eventos no verificables.
      this.logger.warn('Webhook recibido pero el gateway activo no soporta verificación; rechazado');
      throw new UnauthorizedError('El gateway activo no verifica webhooks');
    }

    // Lanza UnauthorizedError (→401) si la firma es inválida. No logueamos el cuerpo crudo.
    const result = this.gateway.verifyWebhook(rawBody, headers);

    if (result.kind === 'affiliation') {
      await this.affiliations.markFromWebhook({
        affiliationId: result.order,
        walletUid: result.externalId || undefined,
        status: result.status,
      });
      return;
    }

    // kind 'payment': el `order` es nuestro paymentId. Transición idempotente.
    // `errorCode` (p.ej. YPTRX002 = saldo insuficiente) viaja para un recibo honesto.
    await this.payments.applyWebhookResult({
      paymentId: result.order,
      externalUid: result.externalId,
      status: result.status,
      errorCode: result.errorCode,
    });
  }
}
