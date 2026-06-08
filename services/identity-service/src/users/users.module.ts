import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { DeletionSweeper } from './deletion.sweeper';
import { PhoneLinkService } from './phone-link.service';

@Module({
  // AuthModule provee OtpService (reuso de la infra OTP del login para phone-link).
  imports: [AuthModule],
  providers: [UsersService, DeletionSweeper, PhoneLinkService],
  controllers: [UsersController],
  exports: [UsersService, DeletionSweeper],
})
export class UsersModule {}
