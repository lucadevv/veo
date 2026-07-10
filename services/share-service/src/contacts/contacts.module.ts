import { Module, type Provider } from '@nestjs/common';
import { SmsModule } from '../ports/sms/sms.module';
import { ContactsService } from './contacts.service';
import { CONTACTS_REPO, PrismaContactsRepository } from './contacts.repository';
import { ContactOtpService } from './contact-otp.service';
import { ContactsController } from './contacts.controller';

// FOUNDATION §10: el service accede a Prisma SOLO por este puerto (unit-of-work), nunca `this.prisma`.
const contactsRepoProvider: Provider = { provide: CONTACTS_REPO, useClass: PrismaContactsRepository };

@Module({
  imports: [SmsModule],
  providers: [ContactsService, ContactOtpService, contactsRepoProvider],
  controllers: [ContactsController],
  exports: [ContactsService],
})
export class ContactsModule {}
