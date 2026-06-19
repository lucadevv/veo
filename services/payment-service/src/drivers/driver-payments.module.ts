/**
 * DriverPaymentsModule — endpoint interno del HARD purge en cascada del dinero de un conductor (DEV-only,
 * invocado por el admin-bff). PrismaService, InternalIdentityGuard y RolesGuard son globales (CoreModule);
 * el controller los resuelve del contenedor sin re-proveerlos.
 */
import { Module } from '@nestjs/common';
import { DriverPaymentsController } from './driver-payments.controller';
import { DriverPaymentsService } from './driver-payments.service';

@Module({
  controllers: [DriverPaymentsController],
  providers: [DriverPaymentsService],
})
export class DriverPaymentsModule {}
