import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersService } from './users.service';
import { UsersRepository } from './users.repository';
import { UsersController } from './users.controller';
import { DeletionSweeper } from './deletion.sweeper';
import { PhoneLinkService } from './phone-link.service';
import { PhoneLinkRepository } from './phone-link.repository';

@Module({
  // AuthModule provee OtpService (reuso de la infra OTP del login para phone-link).
  imports: [AuthModule],
  providers: [
    UsersService,
    UsersRepository,
    DeletionSweeper,
    PhoneLinkService,
    PhoneLinkRepository,
  ],
  controllers: [UsersController],
  exports: [UsersService, DeletionSweeper],
})
export class UsersModule {}
