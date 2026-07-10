import { Module, type Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import {
  HealthController,
  MetricsController,
  READINESS_CHECKS,
  type ReadinessCheck,
} from '@veo/observability';
import type Redis from 'ioredis';
import { validateEnv } from './config/env.schema';
import { CoreModule } from './infra/core.module';
import { PrismaService } from './infra/prisma.service';
import { REDIS } from './infra/redis';
import { VehiclesModule } from './vehicles/vehicles.module';
import { VehicleModelsModule } from './vehicle-models/vehicle-models.module';
import { DocumentsModule } from './documents/documents.module';
import { EventsModule } from './events/events.module';
import { InspectionsModule } from './inspections/inspections.module';
import { FleetGrpcController } from './grpc/fleet.grpc.controller';
import { FLEET_GRPC_REPO, PrismaFleetGrpcRepository } from './grpc/fleet-grpc.repository';

const readinessProvider: Provider = {
  provide: READINESS_CHECKS,
  inject: [PrismaService, REDIS],
  useFactory: (prisma: PrismaService, redis: Redis): ReadinessCheck[] => [
    {
      name: 'postgres',
      check: async () => {
        await prisma.read.$queryRaw`SELECT 1`;
        return true;
      },
    },
    {
      name: 'redis',
      check: async () => (await redis.ping()) === 'PONG',
    },
  ],
};

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    ScheduleModule.forRoot(),
    CoreModule,
    VehiclesModule,
    VehicleModelsModule,
    DocumentsModule,
    InspectionsModule,
    EventsModule,
  ],
  controllers: [HealthController, MetricsController, FleetGrpcController],
  // §10: FLEET_GRPC_REPO es el dueño del acceso Prisma del FleetGrpcController (lector cross-feature).
  providers: [
    readinessProvider,
    { provide: FLEET_GRPC_REPO, useClass: PrismaFleetGrpcRepository },
  ],
})
export class AppModule {}
