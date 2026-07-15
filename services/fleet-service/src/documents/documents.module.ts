import { Module } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';
import { DOCUMENTS_REPO, PrismaDocumentsRepository } from './documents.repository';
import { ExpirySweeper } from '../expirations/expiry.sweeper';
import { ExpirationsController } from '../expirations/expirations.controller';
import { EXPIRATIONS_REPO, PrismaExpirationsRepository } from '../expirations/expirations.repository';
import { InspectionsModule } from '../inspections/inspections.module';

@Module({
  imports: [InspectionsModule],
  // §10: cada acceso a Prisma pasa por el repo del feature. DOCUMENTS_REPO para el service; EXPIRATIONS_REPO
  // es el dueño del acceso Prisma del ExpirySweeper (cron cross-feature docs/vehículos/inspecciones), que vive
  // en este module.
  providers: [
    DocumentsService,
    ExpirySweeper,
    { provide: DOCUMENTS_REPO, useClass: PrismaDocumentsRepository },
    { provide: EXPIRATIONS_REPO, useClass: PrismaExpirationsRepository },
  ],
  controllers: [DocumentsController, ExpirationsController],
  exports: [DocumentsService, ExpirySweeper],
})
export class DocumentsModule {}
