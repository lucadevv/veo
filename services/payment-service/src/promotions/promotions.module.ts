import { Module } from '@nestjs/common';
import { PromotionsService } from './promotions.service';
import { PromotionsRepository } from './promotions.repository';
import { PromotionsController } from './promotions.controller';

/**
 * Módulo de promociones/cupones (Ola 2A). Vive DENTRO de payment-service (mismo bounded context
 * "dinero"): el descuento se aplica al cobro sin join cross-servicio ni un servicio extra. Exporta
 * el servicio para que PaymentsService aplique la promo al cobrar (POST /payments/charge).
 */
@Module({
  controllers: [PromotionsController],
  providers: [PromotionsService, PromotionsRepository],
  exports: [PromotionsService],
})
export class PromotionsModule {}
