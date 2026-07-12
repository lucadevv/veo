/**
 * CatalogService (ADR 013 §1.2 · admin-bff) — proxy del overlay del catálogo de ofertas hacia
 * trip-service vía REST interno firmado (InternalRestClient). Espeja `PricingService`: el BFF propaga la
 * identidad `admin` autenticada por JWT (firma HMAC, NUNCA el JWT crudo) → trip-service la verifica con
 * InternalIdentityGuard y, para el PUT, con AdminIdentityGuard (type==='admin'). El RBAC fino
 * (catalog:view / catalog:manage) se aplica en el controller con @Roles. La mutación se audita (Ley 29733).
 */
import { Inject, Injectable } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type { ResolvedOffering, OfferingOverride } from '@veo/shared-types';
import { REST_TRIP } from '../infra/tokens';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { ReplaceCatalogDto } from './dto/catalog.dto';

/**
 * Vista del catálogo efectivo que trip-service produce (base de código ⟕ overlay del admin). Contrato
 * COMPARTIDO: usamos los MISMOS tipos que el productor (`ResolvedOffering`/`OfferingOverride` de
 * @veo/shared-types) en vez de re-declarar tipos locales — así el grafo no detecta drift y un cambio en
 * el productor rompe en compile-time acá (no en silencio).
 */
export interface CatalogView {
  version: number;
  updatedAt: string;
  offerings: ResolvedOffering[];
  overrides: OfferingOverride[];
}

/**
 * Métricas 30d de UNA oferta para la página-detalle del catálogo (board HjDvx). Contrato del wire admin-bff↔web:
 * lo produce trip-service (GET /internal/analytics/offering-metrics · datos PROPIOS por Trip.category, sin
 * cross-service). HONESTIDAD DE DATOS: `grossFareCents` es facturación BRUTA (Σ Trip.fareCents), NO el revenue
 * neto de la plataforma (payment-service no denormaliza la oferta → sin fuente); el rating por oferta tampoco
 * tiene fuente → ninguno se expone acá. La UI muestra "Viajes" + "Ingreso (bruto)" y omite el resto.
 */
export interface OfferingMetricsView {
  offeringId: string;
  windowDays: number;
  tripCount: number;
  grossFareCents: number;
}

const BASE = '/internal/catalog';
const ANALYTICS_OFFERING_METRICS = '/internal/analytics/offering-metrics';

@Injectable()
export class CatalogService {
  constructor(
    @Inject(REST_TRIP) private readonly rest: InternalRestClient,
    private readonly audit: AuditRecorder,
  ) {}

  /** catalog:view — lee el catálogo efectivo (todas las ofertas con su `enabled` + version). */
  getCatalog(identity: AuthenticatedUser): Promise<CatalogView> {
    return this.rest.get<CatalogView>(BASE, { identity });
  }

  /**
   * catalog:view — métricas 30d de UNA oferta (página-detalle · board HjDvx). Proxya a trip-service
   * (dueño de `Trip.category` + `fareCents`), propagando la identidad admin firmada. Solo LECTURA (no audita:
   * no muta nada). trip-service RE-valida el `offeringId` contra el enum del catálogo (400 si es desconocido).
   */
  getMetrics(identity: AuthenticatedUser, offeringId: string): Promise<OfferingMetricsView> {
    return this.rest.get<OfferingMetricsView>(ANALYTICS_OFFERING_METRICS, {
      identity,
      query: { offeringId },
    });
  }

  /** catalog:manage — reemplaza wholesale el overlay. trip-service bump-ea version y emite catalog.updated. */
  async replaceCatalog(identity: AuthenticatedUser, dto: ReplaceCatalogDto): Promise<CatalogView> {
    const res = await this.rest.put<CatalogView>(BASE, {
      identity,
      body: { overrides: dto.overrides, expectedVersion: dto.expectedVersion },
    });
    await this.audit.record(identity, {
      action: 'catalog.overlay_replace',
      resourceType: 'offering_catalog',
      resourceId: String(res.version),
      payload: { overrideCount: dto.overrides.length, version: res.version },
    });
    return res;
  }
}
