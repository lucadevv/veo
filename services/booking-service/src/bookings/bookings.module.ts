import { Module } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { BookingsRepository } from './bookings.repository';
import { BookingsController } from './bookings.controller';

@Module({
  providers: [BookingsService, BookingsRepository],
  controllers: [BookingsController],
  exports: [BookingsService],
})
export class BookingsModule {}
