/**
 * CommissionModule (F2.7) — la comisión de plataforma por modo, editable en caliente. Expone CommissionService
 * (lo inyecta PaymentsService para resolver la tasa por modo al cobrar), el endpoint interno admin (GET/PUT) y
 * el consumer de invalidación de cache cross-réplica. Espeja el wiring del pricing de trip-service.
 */
import { Module } from '@nestjs/common';
import { CommissionService } from './commission.service';
import { CommissionController } from './commission.controller';
import { CommissionCacheConsumer } from './commission-cache.consumer';
import { COMMISSION_REPO, PrismaCommissionRepository } from './commission.repository';

@Module({
  providers: [
    CommissionService,
    CommissionCacheConsumer,
    { provide: COMMISSION_REPO, useClass: PrismaCommissionRepository },
  ],
  controllers: [CommissionController],
  exports: [CommissionService],
})
export class CommissionModule {}
