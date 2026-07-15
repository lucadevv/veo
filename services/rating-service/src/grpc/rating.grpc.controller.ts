/**
 * Controlador gRPC de rating (paquete veo.rating.v1.RatingService).
 * Lectura síncrona del agregado para el scoring de dispatch. Devuelve `found=false` en vez de
 * lanzar, para que el llamante decida (evita ruido de errores cross-servicio).
 */
import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus, type Metadata } from '@grpc/grpc-js';
import { verifyGrpcIdentity, InternalAudience, type InternalIdentity } from '@veo/auth';
import { RatingsService } from '../ratings/ratings.service';
import { scopeAggregateForRail } from '../ratings/domain/moderation-scope';
import type { Env } from '../config/env.schema';

interface GetAggregateRequest {
  subjectId: string;
}

interface AggregateReply {
  subjectId: string;
  role: string;
  rollingAvg30d: number;
  count30d: number;
  flagged: boolean;
  flagReason: string;
  lastComputedAt: string;
  found: boolean;
}

const EMPTY: AggregateReply = {
  subjectId: '',
  role: '',
  rollingAvg30d: 0,
  count30d: 0,
  flagged: false,
  flagReason: '',
  lastComputedAt: '',
  found: false,
};

/**
 * Métodos gRPC de RatingService scopeados por RIEL. Cada RPC declara EXACTAMENTE qué rieles pueden
 * invocarla (derivado de los callers reales · cross-rail / confused-deputy H7): el HMAC válido NO basta,
 * el `aud` firmado del caller DEBE estar en esta lista o se rechaza fail-closed (PERMISSION_DENIED).
 * Mapa tipado y centralizado — NUNCA un string mágico ni un `ALLOWED_AUDIENCES` global.
 *
 * GetAggregate lo invocan TRES rieles:
 *  - PUBLIC_RAIL (public-bff: agregado/share/trips/enriquecimiento del pasajero): lee avg/count → la
 *    REPUTACIÓN pública. NUNCA debe ver el estado de MODERACIÓN del conductor (flagged/flagReason).
 *  - DRIVER_RAIL (driver-bff /drivers/me): el conductor ve SU PROPIO flag (subjectId = su propio
 *    driver.id derivado de la identidad autenticada) — transparencia, no IDOR.
 *  - SERVICE_RAIL (dispatch · scoring): lee avg/count para el matching.
 *
 * NOTA least-privilege (BAJA · GetAggregate audiences): HOY dispatch NO llama este gRPC — mantiene su
 * propia proyección de scoring por Kafka (`rating.created`/`driver.flagged`), ver dispatch-service. El
 * proto documenta a dispatch como consumidor FUTURO de GetAggregate por SERVICE_RAIL, así que SERVICE_RAIL
 * se CONSERVA deliberadamente (no es over-broad explotable: el scoping de moderación lo zeroa igual que a
 * PUBLIC_RAIL). Si esa intención se descarta, quitar SERVICE_RAIL de aquí y de su test es el cierre limpio.
 */
const GRPC_METHOD_AUDIENCES = {
  GetAggregate: [
    InternalAudience.PUBLIC_RAIL,
    InternalAudience.DRIVER_RAIL,
    InternalAudience.ADMIN_RAIL,
    InternalAudience.SERVICE_RAIL,
  ],
} as const satisfies Record<string, readonly InternalAudience[]>;

type GrpcMethodName = keyof typeof GRPC_METHOD_AUDIENCES;

@Controller()
export class RatingGrpcController {
  private readonly secret: string;

  constructor(
    private readonly ratings: RatingsService,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('INTERNAL_IDENTITY_SECRET', { infer: true });
  }

  /**
   * Verifica la identidad interna firmada (HMAC) Y acota el RIEL emisor al conjunto permitido del MÉTODO
   * (scoping por-RPC · confused-deputy). Dos rechazos honestos:
   *  - firma ausente/inválida → UNAUTHENTICATED (no probó quién es).
   *  - firma válida pero riel no autorizado → PERMISSION_DENIED (probó quién es, no puede).
   */
  private requireIdentity(method: GrpcMethodName, metadata: Metadata): InternalIdentity {
    const identity = verifyGrpcIdentity(metadata, this.secret);
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

  @GrpcMethod('RatingService', 'GetAggregate')
  async getAggregate(
    { subjectId }: GetAggregateRequest,
    metadata: Metadata,
  ): Promise<AggregateReply> {
    const identity = this.requireIdentity('GetAggregate', metadata);
    const agg = await this.ratings.getAggregate(subjectId);
    if (!agg) return EMPTY;
    // SCOPING DE MODERACIÓN POR RIEL (anti-IDOR · fuga de moderación H8): el PUNTO DE DECISIÓN ÚNICO vive en
    // `scopeAggregateForRail` (domain/moderation-scope) — el MISMO helper que usa el REST GET /ratings/aggregate,
    // sin clonar el `aud === DRIVER || ADMIN`. PUBLIC_RAIL (pasajero, cualquier subjectId) y SERVICE_RAIL
    // (dispatch, solo scorea avg/count) reciben `flagged=false/flagReason=null`; DRIVER/ADMIN ven la moderación.
    const scoped = scopeAggregateForRail(agg, identity.aud);
    return {
      subjectId: scoped.subjectId,
      role: scoped.role,
      rollingAvg30d: scoped.rollingAvg30d,
      count30d: scoped.count30d,
      flagged: scoped.flagged,
      // proto3 string default honesto: `flagReason=null` (moderación no expuesta o sin razón) → ''.
      flagReason: scoped.flagReason ?? '',
      lastComputedAt: scoped.lastComputedAt.toISOString(),
      found: true,
    };
  }
}
