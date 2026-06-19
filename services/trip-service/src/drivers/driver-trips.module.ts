/**
 * DriverTripsModule — endpoints internos del conductor para el admin-bff: el guard "¿tiene viajes?"
 * (trip-count) y el HARD purge en cascada de sus viajes (DEV-only). PrismaService, InternalIdentityGuard
 * y RolesGuard son globales (CoreModule); el controller los resuelve del contenedor sin re-proveerlos.
 */
import { Module } from '@nestjs/common';
import { DriverTripsController } from './driver-trips.controller';
import { DriverTripsService } from './driver-trips.service';

@Module({
  controllers: [DriverTripsController],
  providers: [DriverTripsService],
})
export class DriverTripsModule {}
