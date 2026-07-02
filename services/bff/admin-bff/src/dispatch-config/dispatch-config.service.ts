/**
 * DispatchConfigService — proxy de la config de RADIOS (k-rings) de dispatch hacia dispatch-service vía
 * REST interno firmado (InternalRestClient). El BFF propaga la identidad `admin` autenticada por JWT
 * (firma HMAC, NUNCA el JWT crudo) → dispatch-service la verifica con InternalIdentityGuard y, para el PUT,
 * con AdminIdentityGuard (exige type==='admin'). El RBAC fino se aplica en el controller con @Roles.
 * La mutación se audita (Ley 29733). Espejo del PricingService.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import { REST_DISPATCH } from '../infra/tokens';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { ReplaceRadiusConfigDto } from './dto/dispatch-radius-config.dto';

/** Vista de la config de radios + ventanas devuelta por dispatch-service (config vigente o el DEFAULT). */
export interface RadiusConfigView {
  nearbyKRing: number;
  matchKRing: number;
  /** Ventana (ms) de la oferta directa FIXED. */
  offerTimeoutMs: number;
  /** Ventana (s) del board de PUJA. */
  bidWindowSec: number;
  version: number;
  updatedAt: string;
}

const BASE = '/internal/dispatch/radius-config';

/** Acción de audit de la mutación (sin magic strings sueltos). */
const AUDIT_ACTION = 'dispatch.radius_config_replace' as const;
const AUDIT_RESOURCE_TYPE = 'dispatch_radius_config' as const;

@Injectable()
export class DispatchConfigService {
  constructor(
    @Inject(REST_DISPATCH) private readonly rest: InternalRestClient,
    private readonly audit: AuditRecorder,
  ) {}

  /** Lee la config de radios vigente (o el DEFAULT con version 0 si no hay config). */
  getRadiusConfig(identity: AuthenticatedUser): Promise<RadiusConfigView> {
    return this.rest.get<RadiusConfigView>(BASE, { identity });
  }

  /** Reemplaza la config de radios. dispatch-service bump-ea version y emite el evento. */
  async replaceRadiusConfig(
    identity: AuthenticatedUser,
    dto: ReplaceRadiusConfigDto,
  ): Promise<RadiusConfigView> {
    const res = await this.rest.put<RadiusConfigView>(BASE, {
      identity,
      body: {
        nearbyKRing: dto.nearbyKRing,
        matchKRing: dto.matchKRing,
        offerTimeoutMs: dto.offerTimeoutMs,
        bidWindowSec: dto.bidWindowSec,
      },
    });
    await this.audit.record(identity, {
      action: AUDIT_ACTION,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: String(res.version),
      payload: {
        nearbyKRing: res.nearbyKRing,
        matchKRing: res.matchKRing,
        offerTimeoutMs: res.offerTimeoutMs,
        bidWindowSec: res.bidWindowSec,
        version: res.version,
      },
    });
    return res;
  }
}
