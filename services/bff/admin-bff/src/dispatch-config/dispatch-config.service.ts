/**
 * DispatchConfigService — proxy de la config de RADIOS (k-rings + política geométrica v2) de dispatch hacia
 * dispatch-service, y del radio de búsqueda del CARPOOLING hacia booking-service, ambos vía REST interno
 * firmado (InternalRestClient). El BFF propaga la identidad `admin` autenticada por JWT (firma HMAC, NUNCA el
 * JWT crudo) → cada servicio la verifica con InternalIdentityGuard y, para el PUT, con AdminIdentityGuard
 * (exige type==='admin'). El RBAC fino se aplica en el controller con @Roles. La mutación se audita
 * (Ley 29733). Espejo del PricingService.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import { REST_DISPATCH, REST_BOOKING } from '../infra/tokens';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { ReplaceRadiusConfigDto, ReplaceCarpoolConfigDto } from './dto/dispatch-radius-config.dto';

/** Un modo de despacho para el radar (FIXED = oferta directa geométrica; PUJA = board por broadcast). */
export type DispatchMode = 'FIXED' | 'PUJA';

/** Política v2 del modo FIXED (radio geométrico + expansión por anillos). */
export interface FixedPolicyView {
  initialRadiusKm: number;
  incrementKm: number;
  maxRadiusKm: number;
  targetDrivers: number;
  offerTimeoutSec: number;
  expandIntervalSec: number;
}

/** Política v2 del modo PUJA (broadcast a un radio único + ventana de board). */
export interface PujaPolicyView {
  broadcastRadiusKm: number;
  bidWindowSec: number;
}

/** Bloque de política geométrica v2 por modo. `null` cuando `policyVersion==='v1'`. */
export interface DispatchPolicyV2View {
  FIXED: FixedPolicyView;
  PUJA: PujaPolicyView;
}

/** Vista de la config de radios + ventanas devuelta por dispatch-service (config vigente o el DEFAULT). */
export interface RadiusConfigView {
  nearbyKRing: number;
  matchKRing: number;
  /** Ventana (ms) de la oferta directa FIXED. */
  offerTimeoutMs: number;
  /** Ventana (s) del board de PUJA. */
  bidWindowSec: number;
  /** `v1` = solo k-rings (legacy); `v2` = política geométrica por modo (en `policyV2`). */
  policyVersion: 'v1' | 'v2';
  /** Política geométrica por modo. `null` en `v1`. */
  policyV2: DispatchPolicyV2View | null;
  version: number;
  updatedAt: string;
}

/** Vista del radio de búsqueda del carpooling (booking-service, singleton global). */
export interface CarpoolSearchConfigView {
  baseRadiusKm: number;
  expandRadiusKm: number;
  version: number;
  updatedAt: string;
}

/** Anillo del radar UNIFORME hacia el admin (`count` sea cual sea el servicio de origen). */
export interface RadarRingView {
  radiusKm: number;
  kRing: number;
  count: number;
}

/** Una POSICIÓN (lat/lon) para plotear un marcador en el mapa del radar admin. Sin PII (solo el punto). */
export interface RadarDriverPositionView {
  lat: number;
  lon: number;
}

/** Preview del radar: centro + anillos + total en rango + muestra de posiciones. `mode` presente solo en el radar de dispatch. */
export interface RadarPreviewView {
  mode?: string;
  center: { lat: number; lon: number };
  rings: RadarRingView[];
  totalInRange: number;
  /** MUESTRA (capada a 100) de posiciones reales para plotear marcadores; `[]` si el servicio no las provee. */
  drivers: RadarDriverPositionView[];
}

/** Forma CRUDA del anillo del radar de dispatch (usa `driverCount`, no `count`). */
interface DispatchRadarRingRaw {
  radiusKm: number;
  kRing: number;
  driverCount: number;
}
interface DispatchRadarRaw {
  mode: string;
  center: { lat: number; lon: number };
  rings: DispatchRadarRingRaw[];
  totalInRange: number;
  /** Muestra de posiciones reales de conductores del anillo más ancho (dispatch la sirve directa). */
  drivers?: RadarDriverPositionView[];
}

const BASE = '/internal/dispatch/radius-config';
const DISPATCH_RADAR = '/internal/dispatch/radar-preview';
const CARPOOL_BASE = '/internal/booking/search-radius-config';
const CARPOOL_RADAR = '/internal/booking/radar-preview';

/** Acciones de audit de las mutaciones (sin magic strings sueltos). */
const AUDIT_ACTION = 'dispatch.radius_config_replace' as const;
const AUDIT_RESOURCE_TYPE = 'dispatch_radius_config' as const;
const CARPOOL_AUDIT_ACTION = 'dispatch.carpool_radius_config_replace' as const;
const CARPOOL_AUDIT_RESOURCE_TYPE = 'carpool_search_radius_config' as const;

@Injectable()
export class DispatchConfigService {
  constructor(
    @Inject(REST_DISPATCH) private readonly rest: InternalRestClient,
    // El radio de búsqueda del CARPOOLING vive en booking-service (no en dispatch): cliente REST propio.
    @Inject(REST_BOOKING) private readonly bookingRest: InternalRestClient,
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
        // v2 (opcional, back-compat): solo viajan si el panel los manda.
        ...(dto.policyVersion !== undefined ? { policyVersion: dto.policyVersion } : {}),
        ...(dto.policyV2 !== undefined ? { policyV2: dto.policyV2 } : {}),
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
        policyVersion: res.policyVersion,
        policyV2: res.policyV2,
        version: res.version,
      },
    });
    return res;
  }

  /**
   * Radar de dispatch: anillos de cobertura para un punto (visualización de la config vigente).
   * NORMALIZA `driverCount` → `count` para que el contrato hacia el admin sea uniforme con el del carpooling.
   */
  async radarPreview(
    identity: AuthenticatedUser,
    mode: DispatchMode,
    lat: number,
    lon: number,
  ): Promise<RadarPreviewView> {
    const raw = await this.rest.get<DispatchRadarRaw>(DISPATCH_RADAR, {
      identity,
      query: { mode, lat, lon },
    });
    return {
      mode: raw.mode,
      center: raw.center,
      rings: raw.rings.map((r) => ({ radiusKm: r.radiusKm, kRing: r.kRing, count: r.driverCount })),
      totalInRange: raw.totalInRange,
      // Posiciones reales para el mapa (passthrough); [] si un dispatch viejo aún no las sirve (degradación honesta).
      drivers: raw.drivers ?? [],
    };
  }

  /** Lee el radio de búsqueda del carpooling vigente (booking-service). */
  getCarpoolConfig(identity: AuthenticatedUser): Promise<CarpoolSearchConfigView> {
    return this.bookingRest.get<CarpoolSearchConfigView>(CARPOOL_BASE, { identity });
  }

  /** Reemplaza el radio de búsqueda del carpooling. booking-service bump-ea version. */
  async replaceCarpoolConfig(
    identity: AuthenticatedUser,
    dto: ReplaceCarpoolConfigDto,
  ): Promise<CarpoolSearchConfigView> {
    const res = await this.bookingRest.put<CarpoolSearchConfigView>(CARPOOL_BASE, {
      identity,
      body: {
        baseRadiusKm: dto.baseRadiusKm,
        expandRadiusKm: dto.expandRadiusKm,
      },
    });
    await this.audit.record(identity, {
      action: CARPOOL_AUDIT_ACTION,
      resourceType: CARPOOL_AUDIT_RESOURCE_TYPE,
      resourceId: String(res.version),
      payload: {
        baseRadiusKm: res.baseRadiusKm,
        expandRadiusKm: res.expandRadiusKm,
        version: res.version,
      },
    });
    return res;
  }

  /**
   * Radar del carpooling: anillos de cobertura para un punto (booking-service). booking ya sirve `count`,
   * así que el mapeo es passthrough tipado (contrato uniforme con el radar de dispatch, sin `mode`).
   */
  async carpoolRadar(
    identity: AuthenticatedUser,
    lat: number,
    lon: number,
  ): Promise<RadarPreviewView> {
    const raw = await this.bookingRest.get<RadarPreviewView>(CARPOOL_RADAR, {
      identity,
      query: { lat, lon },
    });
    return {
      center: raw.center,
      rings: raw.rings.map((r) => ({ radiusKm: r.radiusKm, kRing: r.kRing, count: r.count })),
      totalInRange: raw.totalInRange,
      // Orígenes reales de las ofertas en rango para el mapa (passthrough); [] si booking no los sirve.
      drivers: raw.drivers ?? [],
    };
  }
}
