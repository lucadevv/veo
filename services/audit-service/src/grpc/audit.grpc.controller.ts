/**
 * Controlador gRPC de audit (paquete veo.audit.v1.AuditService).
 * Registro y verificación síncronos para otros servicios.
 *
 * INTEGRIDAD DEL WORM (Ley 29733): el `actorId` que se persiste en la cadena append-only NO se toma
 * NUNCA del body del request (forjable por un caller interno comprometido/buggy) — se DERIVA de la
 * identidad interna firmada (HMAC) que el caller propaga en la metadata gRPC. Espeja el patrón de
 * rating-service/media-service: `verifyGrpcIdentity` + audience scoping por-RPC (fail-closed). El
 * `actor_id` del proto queda como campo legacy IGNORADO: quién hizo la acción lo decide la firma, no
 * el payload.
 */
import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus, type Metadata } from '@grpc/grpc-js';
import { verifyGrpcIdentity, InternalAudience, type InternalIdentity } from '@veo/auth';
import { ValidationError, isHardenedEnv } from '@veo/utils';
import { AuditService } from '../audit/audit.service';
import type { Env } from '../config/env.schema';

interface RecordRequest {
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  payloadJson: string;
  // Id estable del evento (UUIDv7) para idempotencia. proto3 + defaults:true → "" cuando el caller no lo manda;
  // opcional acá porque un caller legacy puede no setearlo (`req.eventId || undefined` lo normaliza a ausente).
  eventId?: string;
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

/**
 * Audiencias de RIEL permitidas POR MÉTODO gRPC (scoping por-RPC · confused-deputy / cross-rail). El HMAC
 * válido NO basta: el `aud` firmado del caller DEBE estar en esta lista o se rechaza fail-closed
 * (PERMISSION_DENIED). Mapa tipado y centralizado — NUNCA un string mágico ni un `ALLOWED_AUDIENCES` global.
 *
 *  - Record: el ÚNICO caller real es el admin-bff (AuditRecorder), que firma con `admin-rail` al registrar
 *    acciones sensibles del back-office en el WORM. Mínimo privilegio: SOLO `admin-rail`. (El carril
 *    service-rail de ESCRITURA síncrona del resto del dominio va por REST POST /audit, gateado por el
 *    InternalIdentityGuard del servicio; este gRPC Record no lo usa hoy ningún service-rail.)
 *  - Verify: verificación de integridad de la cadena (lectura de compliance). La consulta del WORM la hace
 *    el operador (admin-bff → REST GET /audit/verify, RBAC COMPLIANCE_SUPERVISOR/SUPERADMIN), `admin-rail`.
 */
const GRPC_METHOD_AUDIENCES = {
  Record: [InternalAudience.ADMIN_RAIL],
  Verify: [InternalAudience.ADMIN_RAIL],
} as const satisfies Record<string, readonly InternalAudience[]>;

type GrpcMethodName = keyof typeof GRPC_METHOD_AUDIENCES;

@Controller()
export class AuditGrpcController {
  private readonly secret: string;

  constructor(
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('INTERNAL_IDENTITY_SECRET', { infer: true });
  }

  /**
   * Verifica la identidad interna firmada (HMAC) Y acota el RIEL emisor al conjunto permitido del MÉTODO.
   * Dos rechazos honestos:
   *  - firma ausente/inválida → UNAUTHENTICATED (no probó quién es).
   *  - firma válida pero riel no autorizado → PERMISSION_DENIED (probó quién es, no puede).
   */
  private requireIdentity(method: GrpcMethodName, metadata: Metadata): InternalIdentity {
    // Ventana anti-replay: 30s en endurecido, relajada en dev (el reloj de dev se manipula → skew).
    // ESPEJO EXACTO del carril REST (InternalIdentityGuard) — si no, el admin-bff fail-closed rompe en dev.
    const identity = verifyGrpcIdentity(
      metadata,
      this.secret,
      isHardenedEnv() ? {} : { maxAgeMs: 86_400_000 },
    );
    if (!identity) {
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'Identidad interna inválida o ausente',
      });
    }
    const allowed: readonly InternalAudience[] = GRPC_METHOD_AUDIENCES[method];
    if (!allowed.includes(identity.aud)) {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: 'Riel no autorizado para esta operación',
      });
    }
    return identity;
  }

  @GrpcMethod('AuditService', 'Record')
  async record(req: RecordRequest, metadata: Metadata): Promise<RecordReply> {
    const identity = this.requireIdentity('Record', metadata);
    // INTEGRIDAD: el actor que se escribe en el WORM SIEMPRE es la identidad VERIFICADA (firma HMAC),
    // NUNCA `req.actorId` del body (forjable). El campo `actor_id` del proto es legacy ignorado.
    const entry = await this.audit.recordSync({
      actorId: identity.userId,
      action: req.action,
      resourceType: req.resourceType,
      resourceId: req.resourceId,
      payload: parsePayload(req.payloadJson),
      ip: '',
      userAgent: 'grpc',
      // proto3 entrega "" cuando el caller no lo manda → tratá vacío como ausente (caller legacy).
      eventId: req.eventId || undefined,
    });
    return { id: entry.id, seq: String(entry.seq), hash: entry.hash };
  }

  @GrpcMethod('AuditService', 'Verify')
  async verify(req: VerifyRequest, metadata: Metadata): Promise<VerifyReply> {
    this.requireIdentity('Verify', metadata);
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
