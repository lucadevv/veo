import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditRecorder } from './audit-recorder.service';

/** Global: AuditRecorder lo usan ops/security/finance/media para registrar acciones sensibles. */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditRecorder],
  exports: [AuditRecorder],
})
export class AuditModule {}
