import { Module, type Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  HealthController,
  MetricsController,
  READINESS_CHECKS,
  type ReadinessCheck,
} from '@veo/observability';
import { validateEnv } from './config/env.schema';
import { CoreModule } from './infra/core.module';
import { PrismaService } from './infra/prisma.service';
import { AuditModule } from './audit/audit.module';
import { StorageModule, AUDIT_OBJECT_STORE } from './storage/storage.module';
import type { ImmutableObjectStore } from './storage/object-lock.store';

const readinessProvider: Provider = {
  provide: READINESS_CHECKS,
  inject: [PrismaService, AUDIT_OBJECT_STORE],
  useFactory: (prisma: PrismaService, store: ImmutableObjectStore | null): ReadinessCheck[] => {
    const checks: ReadinessCheck[] = [
      {
        name: 'postgres',
        check: async () => {
          await prisma.read.$queryRaw`SELECT 1`;
          return true;
        },
      },
    ];
    if (store) {
      checks.push({ name: 's3_object_lock', check: () => store.healthy() });
    }
    return checks;
  },
};

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    CoreModule,
    StorageModule,
    AuditModule,
  ],
  controllers: [HealthController, MetricsController],
  providers: [readinessProvider],
})
export class AppModule {}
