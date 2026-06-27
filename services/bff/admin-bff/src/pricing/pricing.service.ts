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
import type { PricingMode, EnergySourcePrice, BidFloorOverride } from '@veo/shared-types';
import { REST_TRIP } from '../infra/tokens';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type {
  ReplaceScheduleDto,
  ReplaceFuelSurchargeDto,
  ReplaceBidFloorDto,
  ReplaceBaseFareDto,
} from './dto/pricing.dto';
import type { ReplaceEnergyCatalogDto } from './dto/energy-catalog.dto';

/** Vista del schedule devuelta por trip-service (proyección vigente o el default). */
export interface ModeScheduleView {
  version: number;
  defaultMode: PricingMode;
  rules: { dayMask: number; startMinute: number; endMinute: number; mode: PricingMode }[];
  updatedAt: string | null;
}

/** Vista del recargo de combustible devuelta por trip-service (B4): precio + rendimiento + per-km derivado. */
export interface FuelSurchargeView {
  fuelPricePerLiterCents: number;
  kmPerLiter: number;
  perKmCents: number;
  version: number;
  updatedAt: string;
}

/**
 * Vista del catálogo de energía devuelta por trip-service (B5): precios por fuente + version.
 * `sources` usa el contrato compartido EnergySourcePrice[] (@veo/shared-types) — MISMA forma que produce
 * trip-service, sin re-declararla inline acá (evita divergencia productor↔consumidor).
 */
export interface EnergyCatalogView {
  sources: EnergySourcePrice[];
  version: number;
  updatedAt: string;
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
const FUEL_BASE = '/internal/pricing/fuel-surcharge';
const ENERGY_BASE = '/internal/pricing/energy-catalog';
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

  /** pricing:view — lee el recargo de combustible por km vigente (o 0 si no hay config). B3 */
  getFuelSurcharge(identity: AuthenticatedUser): Promise<FuelSurchargeView> {
    return this.rest.get<FuelSurchargeView>(FUEL_BASE, { identity });
  }

  /** pricing:manage — reemplaza el recargo de combustible. trip-service bump-ea version y emite el evento. */
  async replaceFuelSurcharge(
    identity: AuthenticatedUser,
    dto: ReplaceFuelSurchargeDto,
  ): Promise<FuelSurchargeView> {
    const res = await this.rest.put<FuelSurchargeView>(FUEL_BASE, {
      identity,
      body: {
        fuelPricePerLiterCents: dto.fuelPricePerLiterCents,
        kmPerLiter: dto.kmPerLiter,
        expectedVersion: dto.expectedVersion,
      },
    });
    await this.audit.record(identity, {
      action: 'pricing.fuel_surcharge_replace',
      resourceType: 'fuel_surcharge_config',
      resourceId: String(res.version),
      payload: {
        fuelPricePerLiterCents: dto.fuelPricePerLiterCents,
        kmPerLiter: dto.kmPerLiter,
        version: res.version,
      },
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

  /** pricing:view — lee el catálogo de precios de energía vigente (B5). */
  getEnergyCatalog(identity: AuthenticatedUser): Promise<EnergyCatalogView> {
    return this.rest.get<EnergyCatalogView>(ENERGY_BASE, { identity });
  }

  /** pricing:manage — reemplaza los precios de energía. trip-service bump-ea version y emite el evento. B5 */
  async replaceEnergyCatalog(
    identity: AuthenticatedUser,
    dto: ReplaceEnergyCatalogDto,
  ): Promise<EnergyCatalogView> {
    const res = await this.rest.put<EnergyCatalogView>(ENERGY_BASE, {
      identity,
      body: { sources: dto.sources, expectedVersion: dto.expectedVersion },
    });
    await this.audit.record(identity, {
      action: 'pricing.energy_catalog_replace',
      resourceType: 'energy_catalog',
      resourceId: String(res.version),
      payload: { sourceCount: dto.sources.length, version: res.version },
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
