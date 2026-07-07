/**
 * PricingService (ADR 011 §6 · M3) — proxy del schedule de modo PUJA↔FIJO hacia trip-service vía
 * REST interno firmado (InternalRestClient). El BFF propaga la identidad `admin` autenticada por JWT
 * (firma HMAC, NUNCA el JWT crudo) → trip-service la verifica con InternalIdentityGuard y, para el PUT,
 * con AdminIdentityGuard (exige type==='admin'). El RBAC fino (pricing:view / pricing:manage) se aplica
 * en el controller con @Roles. La mutación se audita (Ley 29733).
 */
import { Inject, Injectable } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type { PricingMode, BidFloorOverride } from '@veo/shared-types';
import { REST_TRIP } from '../infra/tokens';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type {
  ReplaceScheduleDto,
  ReplaceBidFloorDto,
  ReplaceBaseFareDto,
} from './dto/pricing.dto';

/** Vista del schedule devuelta por trip-service (proyección vigente o el default). */
export interface ModeScheduleView {
  version: number;
  defaultMode: PricingMode;
  rules: { dayMask: number; startMinute: number; endMinute: number; mode: PricingMode }[];
  updatedAt: string | null;
}

/** Vista de la tarifa base devuelta por trip-service (F2.4): banderazo + per-km + per-min + version. */
export interface BaseFareView {
  baseFareCents: number;
  perKmCents: number;
  perMinCents: number;
  version: number;
  updatedAt: string;
}

/** Vista del piso de la PUJA devuelta por trip-service (ADR 010 §9.3): default + overrides por (zona, oferta). */
export interface BidFloorView {
  defaultFloorCents: number;
  overrides: BidFloorOverride[];
  version: number;
  updatedAt: string;
}

const BASE = '/internal/pricing/mode-schedule';
const BID_FLOOR_BASE = '/internal/pricing/bid-floor';
const BASE_FARE_BASE = '/internal/pricing/base-fare';

@Injectable()
export class PricingService {
  constructor(
    @Inject(REST_TRIP) private readonly rest: InternalRestClient,
    private readonly audit: AuditRecorder,
  ) {}

  /** pricing:view — lee el schedule vigente (o el default PUJA si no hay config). */
  getSchedule(identity: AuthenticatedUser): Promise<ModeScheduleView> {
    return this.rest.get<ModeScheduleView>(BASE, { identity });
  }

  /** pricing:manage — reemplaza wholesale el schedule. trip-service bump-ea version y emite el evento. */
  async replaceSchedule(
    identity: AuthenticatedUser,
    dto: ReplaceScheduleDto,
  ): Promise<ModeScheduleView> {
    const res = await this.rest.put<ModeScheduleView>(BASE, {
      identity,
      body: {
        defaultMode: dto.defaultMode,
        rules: dto.rules,
        expectedVersion: dto.expectedVersion,
      },
    });
    await this.audit.record(identity, {
      action: 'pricing.mode_schedule_replace',
      resourceType: 'pricing_mode_schedule',
      resourceId: String(res.version),
      payload: { defaultMode: dto.defaultMode, ruleCount: dto.rules.length, version: res.version },
    });
    return res;
  }

  /** pricing:view — lee la tarifa base vigente (banderazo + per-km + per-min, o los defaults del código). F2.4 */
  getBaseFare(identity: AuthenticatedUser): Promise<BaseFareView> {
    return this.rest.get<BaseFareView>(BASE_FARE_BASE, { identity });
  }

  /** pricing:manage — reemplaza la tarifa base. trip-service bump-ea version y emite el evento. F2.4 */
  async replaceBaseFare(
    identity: AuthenticatedUser,
    dto: ReplaceBaseFareDto,
  ): Promise<BaseFareView> {
    const res = await this.rest.put<BaseFareView>(BASE_FARE_BASE, {
      identity,
      body: {
        baseFareCents: dto.baseFareCents,
        perKmCents: dto.perKmCents,
        perMinCents: dto.perMinCents,
        expectedVersion: dto.expectedVersion,
      },
    });
    await this.audit.record(identity, {
      action: 'pricing.base_fare_replace',
      resourceType: 'base_fare_config',
      resourceId: String(res.version),
      payload: {
        baseFareCents: dto.baseFareCents,
        perKmCents: dto.perKmCents,
        perMinCents: dto.perMinCents,
        version: res.version,
      },
    });
    return res;
  }

  /** pricing:view — lee el piso de la PUJA vigente (default + overrides por oferta, o el default S/7). */
  getBidFloor(identity: AuthenticatedUser): Promise<BidFloorView> {
    return this.rest.get<BidFloorView>(BID_FLOOR_BASE, { identity });
  }

  /** pricing:manage — reemplaza el piso de la PUJA. trip-service bump-ea version y emite el evento. */
  async replaceBidFloor(
    identity: AuthenticatedUser,
    dto: ReplaceBidFloorDto,
  ): Promise<BidFloorView> {
    const res = await this.rest.put<BidFloorView>(BID_FLOOR_BASE, {
      identity,
      body: {
        defaultFloorCents: dto.defaultFloorCents,
        overrides: dto.overrides,
        expectedVersion: dto.expectedVersion,
      },
    });
    await this.audit.record(identity, {
      action: 'pricing.bid_floor_replace',
      resourceType: 'bid_floor_config',
      resourceId: String(res.version),
      payload: {
        defaultFloorCents: dto.defaultFloorCents,
        overrideCount: dto.overrides.length,
        version: res.version,
      },
    });
    return res;
  }
}
