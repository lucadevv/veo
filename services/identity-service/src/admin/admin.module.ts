import { Module } from '@nestjs/common';
import { EmailModule } from '../ports/email/email.module';
import { AdminService } from './admin.service';
import { AdminRepository } from './admin.repository';
import { AdminController } from './admin.controller';

@Module({
  imports: [EmailModule],
  providers: [AdminService, AdminRepository],
  controllers: [AdminController],
  exports: [AdminService],
})
export class AdminModule {}
