/**
 * Controlador gRPC de audit (paquete veo.audit.v1.AuditService).
 * Registro y verificación síncronos para otros servicios.
 */
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { ValidationError } from '@veo/utils';
import { AuditService } from '../audit/audit.service';

interface RecordRequest {
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  payloadJson: string;
}
interface RecordReply {
  id: string;
  seq: string;
  hash: string;
}
interface VerifyRequest {
  fromSeq: string;
  toSeq: string;
}
interface VerifyReply {
  valid: boolean;
  checked: number;
  brokenAtSeq: string;
  reason: string;
}

@Controller()
export class AuditGrpcController {
  constructor(private readonly audit: AuditService) {}

  @GrpcMethod('AuditService', 'Record')
  async record(req: RecordRequest): Promise<RecordReply> {
    const entry = await this.audit.recordSync({
      actorId: req.actorId || 'system',
      action: req.action,
      resourceType: req.resourceType,
      resourceId: req.resourceId,
      payload: parsePayload(req.payloadJson),
      ip: '',
      userAgent: 'grpc',
    });
    return { id: entry.id, seq: String(entry.seq), hash: entry.hash };
  }

  @GrpcMethod('AuditService', 'Verify')
  async verify(req: VerifyRequest): Promise<VerifyReply> {
    const result = await this.audit.verifyRange({
      fromSeq: req.fromSeq ? BigInt(req.fromSeq) : undefined,
      toSeq: req.toSeq ? BigInt(req.toSeq) : undefined,
    });
    return {
      valid: result.valid,
      checked: result.checked,
      brokenAtSeq: result.brokenAtSeq ?? '',
      reason: result.reason ?? '',
    };
  }
}

function parsePayload(json: string): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ValidationError('payload_json debe ser un objeto JSON');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError('payload_json inválido (JSON malformado)');
  }
}
