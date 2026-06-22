import { Module } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { BookingsRepository } from './bookings.repository';
import { BookingsController } from './bookings.controller';
import { PaymentModule } from '../ports/payment/payment.module';

@Module({
  // PaymentModule provee el token PAYMENT_GATEWAY (gate de deuda al reservar · §5.4; charge en F3b).
  imports: [PaymentModule],
  providers: [BookingsService, BookingsRepository],
  controllers: [BookingsController],
  exports: [BookingsService],
})
export class BookingsModule {}
