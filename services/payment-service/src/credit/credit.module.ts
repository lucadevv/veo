import { Module } from '@nestjs/common';
import { CreditService } from './credit.service';

/**
 * Crédito gastable del usuario (Ola 2A · redención de referidos). Vive en payment-service (bounded context
 * "dinero"). Exporta el servicio para que el consumer de `referral.rewarded` acredite el saldo; el gasto en
 * el cobro llega en el Lote B. `PrismaService` lo provee el módulo global de infra.
 */
@Module({
  providers: [CreditService],
  exports: [CreditService],
})
export class CreditModule {}
