/**
 * AuditModule — feature principal: registro inmutable, consulta, verificación de cadena,
 * réplica WORM a S3, consumo de eventos auditables y gRPC.
 */
import { Module } from '@nestjs/common';
import { S3ReplicationRelay } from '../storage/s3-replication.relay';
import { outboxRelayProvider } from '../infra/outbox.relay';
import { AuditConsumer } from '../consumers/audit.consumer';
import { AuditGrpcController } from '../grpc/audit.grpc.controller';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditRepository } from './audit.repository';

@Module({
  controllers: [AuditController, AuditGrpcController],
  providers: [AuditRepository, AuditService, AuditConsumer, S3ReplicationRelay, outboxRelayProvider],
  exports: [AuditService, AuditRepository],
})
export class AuditModule {}
