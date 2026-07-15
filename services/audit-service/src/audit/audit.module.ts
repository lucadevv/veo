/**
 * AuditModule — feature principal: registro inmutable, consulta, verificación de cadena,
 * réplica WORM a S3, consumo de eventos auditables y gRPC.
 */
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3ReplicationRelay } from '../storage/s3-replication.relay';
import { outboxRelayProvider } from '../infra/outbox.relay';
import { AuditConsumer } from '../consumers/audit.consumer';
import { AuditGrpcController } from '../grpc/audit.grpc.controller';
import type { Env } from '../config/env.schema';
import { AuditController } from './audit.controller';
import { AuditService, VERIFY_BATCH_SIZE } from './audit.service';
import { AuditRepository } from './audit.repository';

/** Inyecta el tamaño de lote del streaming de `verifyRange` desde la config (env `AUDIT_VERIFY_BATCH_SIZE`). */
const verifyBatchSizeProvider: Provider = {
  provide: VERIFY_BATCH_SIZE,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.get('AUDIT_VERIFY_BATCH_SIZE', { infer: true }),
};

@Module({
  controllers: [AuditController, AuditGrpcController],
  providers: [
    AuditRepository,
    AuditService,
    verifyBatchSizeProvider,
    AuditConsumer,
    S3ReplicationRelay,
    outboxRelayProvider,
  ],
  exports: [AuditService, AuditRepository],
})
export class AuditModule {}
