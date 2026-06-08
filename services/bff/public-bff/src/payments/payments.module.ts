import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { AffiliationsController } from './affiliations.controller';
import { AffiliationsService } from './affiliations.service';

@Module({
  // AffiliationsController ANTES que PaymentsController: aunque las rutas no colisionan por profundidad
  // (`payments/affiliations/yape` son 2 segmentos, `payments/:id` es 1), registrar el path específico
  // primero deja el ruteo inequívoco y a prueba de futuros cambios.
  controllers: [AffiliationsController, PaymentsController],
  providers: [PaymentsService, AffiliationsService],
})
export class PaymentsModule {}
