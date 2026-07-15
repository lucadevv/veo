import { Module } from '@nestjs/common';
import { IncentivesController } from './incentives.controller';
import { IncentivesService } from './incentives.service';
import { IncentivesRepository } from './incentives.repository';

/**
 * Incentivos al conductor (Ola 2C). Vive en payment-service (mismo bounded context "dinero": el bono
 * es un crédito en céntimos). Exporta el servicio para que el consumer de `trip.completed` acumule el
 * progreso de META_VIAJES.
 */
@Module({
  controllers: [IncentivesController],
  providers: [IncentivesService, IncentivesRepository],
  exports: [IncentivesService],
})
export class IncentivesModule {}
