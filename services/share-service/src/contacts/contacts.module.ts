import { Module } from '@nestjs/common';
import { SmsModule } from '../ports/sms/sms.module';
import { ContactsService } from './contacts.service';
import { ContactOtpService } from './contact-otp.service';
import { ContactsController } from './contacts.controller';

@Module({
  imports: [SmsModule],
  providers: [ContactsService, ContactOtpService],
  controllers: [ContactsController],
  exports: [ContactsService],
})
export class ContactsModule {}
