import { Module } from '@nestjs/common';
import { InspectionsService } from './inspections.service';
import { InspectionsController } from './inspections.controller';
import { INSPECTIONS_REPO, PrismaInspectionsRepository } from './inspections.repository';

@Module({
  // §10: INSPECTIONS_REPO es el único dueño de Prisma del feature; el service depende de la interfaz.
  providers: [
    InspectionsService,
    { provide: INSPECTIONS_REPO, useClass: PrismaInspectionsRepository },
  ],
  controllers: [InspectionsController],
  exports: [InspectionsService],
})
export class InspectionsModule {}
