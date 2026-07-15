import { Module } from '@nestjs/common';
import { ReferralsService } from './referrals.service';
import { ReferralsRepository } from './referrals.repository';
import { ReferralsController } from './referrals.controller';
import { ReferralsConsumer } from './referrals.consumer';

/**
 * Referidos (Ola 2A). Vive en identity-service (los usuarios viven aquí). El consumidor de
 * trip.completed otorga la recompensa al referidor cuando el referido completa su 1er viaje.
 */
@Module({
  providers: [ReferralsService, ReferralsRepository, ReferralsConsumer],
  controllers: [ReferralsController],
  exports: [ReferralsService],
})
export class ReferralsModule {}
