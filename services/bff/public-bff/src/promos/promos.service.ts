/**
 * Promos del pasajero (Ola 2A). Previsualiza el descuento de un cupón vía payment-service
 * (REST interno firmado). El `userId` se deriva SIEMPRE de la identidad autenticada, nunca del cliente.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import { REST_PAYMENT } from '../infra/downstream.tokens';
import type { PromoValidationView } from './dto/promo.dto';

@Injectable()
export class PromosService {
  constructor(@Inject(REST_PAYMENT) private readonly paymentRest: InternalRestClient) {}

  validate(user: AuthenticatedUser, code: string, fareCents: number): Promise<PromoValidationView> {
    return this.paymentRest.post<PromoValidationView>('/promotions/validate', {
      identity: user,
      body: { code, userId: user.userId, fareCents },
    });
  }
}
