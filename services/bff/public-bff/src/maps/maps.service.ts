/**
 * Dominio de mapas del pasajero (UX de previsualización antes de confirmar el viaje).
 * Habla con la infra soberana OSRM/Nominatim vía la fachada @veo/maps; y con trip-service SOLO para
 * resolver el MODO de pricing del quote (ADR 011 M4), no para crear viajes.
 * - autocomplete: sugerencias de direcciones (Nominatim).
 * - reverse: etiqueta del punto actual ("Tu ubicación").
 * - quote: ruta + ETA + tarifa por categoría (OSRM + cálculo determinista local) + modo PUJA/FIXED.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  grpcIdentityMetadata,
  INTERNAL_IDENTITY_SECRET,
  INTERNAL_IDENTITY_AUDIENCE,
  type AuthenticatedUser,
  type InternalAudience,
} from '@veo/auth';
import { NotFoundError } from '@veo/utils';
import type { GeocodeResult, MapsClient } from '@veo/maps';
import { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import {
  isPujaMode,
  OFFERING_LIST,
  OFFERINGS,
  OfferingId,
  PricingMode as PricingModeEnum,
  resolveOfferingModeWithPin,
  resolveBidFloorCents,
  DEFAULT_BID_FLOOR_CONFIG,
  GLOBAL_ZONE,
  type BidFloorConfig,
  type OfferingSpec,
  type OfferingPricingPolicy,
} from '@veo/shared-types';
import { GRPC_PAYMENT, MAPS, REST_TRIP } from '../infra/downstream.tokens';
import { ANONYMOUS_IDENTITY } from '../common/identities';
import type { UserCreditReply } from '../infra/grpc-types';
import type { Env } from '../config/env.schema';
import {
  categoryFareCents,
  categoryFareCentsV2,
  shadowCompareCategoryFare,
  deriveEnergyPerKmCents,
} from './fare';
import { OFFERING_DISPLAY_NAMES } from './offering-names';
import { bumpCatalogDegraded } from './maps-metrics';
import {
  type CatalogResult,
  type PlaceSuggestion,
  type PricingMode,
  type QuoteRequestDto,
  type QuoteResult,
  type ReversePlace,
} from './dto/maps.dto';

/** Longitud mínima del texto para disparar el autocompletado (evita ruido/costos). */
const MIN_QUERY_LENGTH = 3;

/**
 * Oferta ANCLA del quote (ADR 013 §1.3): VEO Económico. Su política alimenta el `suggestedCents`
 * de la PUJA (la tarifa que SERÍA fija con la oferta base) y su modo es el `mode` top-level
 * (compat con apps viejas que no leen `options[].mode`).
 */
const ANCHOR_OFFERING = OFFERINGS[OfferingId.VEO_ECONOMICO];

/** Respuesta del endpoint interno GET /internal/pricing/resolve de trip-service (ADR 011). */
interface ResolveModeReply {
  mode: PricingMode;
}

/** Respuesta de GET /internal/pricing/fuel-surcharge (trip-service · B4): el per-km DERIVADO (precio÷rendimiento). */
interface FuelSurchargeReply {
  perKmCents: number;
}

/** Respuesta de GET /internal/pricing/energy-catalog (trip-service · B5): precios de energía por fuente. */
interface EnergyCatalogReply {
  sources: { sourceId: string; unit: string; pricePerUnitCents: number }[];
  version: number;
  updatedAt: string;
}

/** Respuesta de GET /internal/pricing/bid-floor (trip-service · ADR 010 §9.3): piso por (zona, oferta). */
interface BidFloorReply {
  defaultFloorCents: number;
  overrides: { zone: string; offeringId: string; floorCents: number }[];
  version: number;
  updatedAt: string;
}

/** Respuesta de GET /internal/catalog (trip-service): catálogo efectivo (overlay del admin ⟕ código). */
interface CatalogReply {
  version: number;
  updatedAt: string;
  offerings: {
    id: OfferingId;
    labelKey: string;
    icon: string;
    vehicleClass: 'CAR' | 'MOTO';
    enabled: boolean;
    // B2: pricing EFECTIVO (overlay del admin ⟕ código) + pin de modo (ya validado por trip-service).
    pricing: OfferingPricingPolicy;
    modePin?: PricingMode;
  }[];
}

/** Estado configurable EFECTIVO de una oferta (overlay del admin) que el quote aplica sobre la base de código. */
interface EffectiveOffering {
  pricing: OfferingPricingPolicy;
  modePin?: PricingMode;
}

@Injectable()
export class MapsService {
  private readonly logger = new Logger(MapsService.name);
  /** B5-1.d · FLIP del modelo de energía en el quote (default false). ON = fórmula nueva (pass-through). */
  private readonly energyModelEnabled: boolean;

  constructor(
    @Inject(MAPS) private readonly maps: MapsClient,
    @Inject(REST_TRIP) private readonly tripRest: InternalRestClient,
    config: ConfigService<Env, true>,
    // Opcionales (DI): preview de crédito de referido en el quote (Lote C3). Trailing + @Optional para no
    // romper los specs que construyen/subclasean el servicio con 3 args; sin ellos el quote no trae preview.
    @Optional() @Inject(GRPC_PAYMENT) private readonly paymentGrpc?: GrpcServiceClient,
    @Optional() @Inject(INTERNAL_IDENTITY_SECRET) private readonly secret?: string,
    @Optional() @Inject(INTERNAL_IDENTITY_AUDIENCE) private readonly audience?: InternalAudience,
  ) {
    this.energyModelEnabled = config.getOrThrow<boolean>('PRICING_ENERGY_MODEL_ENABLED');
  }

  /**
   * Autocompletado de direcciones. Devuelve `[]` si el texto es muy corto (<3) o no hay resultados.
   * Si llegan `lat/lng`, sesga las sugerencias por proximidad.
   */
  async autocomplete(q: string, lat?: number, lng?: number): Promise<PlaceSuggestion[]> {
    const query = (q ?? '').trim();
    if (query.length < MIN_QUERY_LENGTH) return [];

    const near = lat !== undefined && lng !== undefined ? { lat, lon: lng } : undefined;
    const results = await this.maps.autocomplete(query, { near });
    return results.map((result) => this.toPlaceSuggestion(result));
  }

  /** Reverse geocoding del punto: etiqueta legible para "Tu ubicación". 404 si no hay dirección. */
  async reverse(lat: number, lng: number): Promise<ReversePlace> {
    const result = await this.maps.reverse({ lat, lon: lng });
    if (!result) {
      throw new NotFoundError('No se encontró una dirección para el punto');
    }
    const { title, subtitle } = this.splitLabel(result);
    return { title, subtitle, lat: result.lat, lng: result.lon };
  }

  /**
   * Cotización ligera: ruta real de OSRM (distancia, duración, geometría GeoJSON) + una opción de
   * tarifa por categoría + el MODO de pricing resuelto por trip-service (ADR 011 M4). El precio es
   * determinista (distancia/tiempo reales). No crea viaje.
   *
   * El modo le dice a la app QUÉ pantalla mostrar:
   *  - FIXED → devuelve `options[].priceCents` como precio firme (comportamiento histórico).
   *  - PUJA  → además expone `bidFloorCents` (piso de la zona) y `suggestedCents` (ancla = la tarifa
   *            que SERÍA fija con la categoría ancla VEO Económico), para la pantalla "proponé tu precio".
   *
   * `identity` se firma para llamar al endpoint interno de trip-service; default ANÓNIMO si el quote se
   * pidiera sin usuario (no debería: la ruta lleva JWT), suficiente para una lectura interna firmada.
   */
  async quote(
    dto: QuoteRequestDto,
    identity: AuthenticatedUser = ANONYMOUS_IDENTITY,
  ): Promise<QuoteResult> {
    const origin = { lat: dto.origin.lat, lon: dto.origin.lng };
    const destination = { lat: dto.destination.lat, lon: dto.destination.lng };
    // Ola 2B · paradas múltiples: la ruta (y por tanto distancia/duración/tarifa) pasa por las paradas.
    const waypoints = (dto.waypoints ?? []).map((w) => ({ lat: w.lat, lon: w.lng }));
    // La ruta, el modo, el crédito y el catálogo activo son independientes → en paralelo.
    const [
      route,
      scheduledMode,
      creditBalanceCents,
      effective,
      fuelPerKmCents,
      energyPrices,
      bidFloorConfig,
    ] = await Promise.all([
      this.maps.route(origin, destination, waypoints),
      // S2 (ADR 011) — si el quote es de una RESERVA (scheduledFor), resolvemos el modo para la hora de
      // RECOJO, no la actual: el preview muestra la política de la hora a la que VA a viajar el pasajero.
      this.resolveMode(dto.origin.lat, dto.origin.lng, identity, dto.scheduledFor),
      // Lote C3 · saldo de crédito de referido para el PREVIEW (server-side, §INTEGRACIONES). 0 si anónimo/
      // sin cliente/error (no rompe el quote: el crédito es secundario a la ruta).
      this.fetchCreditBalance(identity),
      // B2 · catálogo EFECTIVO del admin (habilitadas + pricing + pin de modo). `null` = no disponible →
      // cotizamos TODAS con pricing/modo de CÓDIGO (degradación honesta, como el modo degrada a PUJA).
      this.fetchEffectiveCatalog(identity),
      // B3 · recargo de combustible por km (admin). 0 si no disponible → preview sin recargo (degradación).
      this.fetchFuelPerKmCents(identity),
      // B5-1 · precios de energía por fuente (para el shadow-compare; post-flip será la tarifa autoritativa).
      this.fetchEnergyPrices(identity),
      // ADR 010 §9.3 · config del piso de la PUJA per-(zona, oferta) para el DISPLAY del quote. Degradación
      // honesta: trip-service caído → DEFAULT_BID_FLOOR_CONFIG (piso S/7). El autoritativo lo re-resuelve
      // trip-service en createTrip — acá es solo el piso que la app MUESTRA en "proponé tu precio".
      this.fetchBidFloorConfig(identity),
    ]);

    // ADR 013 §1.3 · el `mode` top-level = el modo de la oferta ANCLA (VEO Económico). B2: respeta su pin
    // de modo efectivo si el admin lo configuró. Sin pin/catálogo caído → schedule ∩ oferta (como antes).
    const mode = resolveOfferingModeWithPin(
      ANCHOR_OFFERING,
      effective?.get(ANCHOR_OFFERING.id)?.modePin,
      scheduledMode,
    ).mode;

    // Las opciones SALEN del catálogo (ADR 013): OFFERING_LIST (código = estructura) ya ordenado por
    // sortOrder. B2: el overlay del admin aporta enabled (filtro) + pricing + pin de modo EFECTIVOS — el
    // MISMO contrato que createTrip (degradación honesta: catálogo caído → pricing/modo de código).
    const options = this.quotedOfferings()
      // Con catálogo del admin: solo las habilitadas (effective.has). En DEGRADACIÓN (effective null):
      // solo las que shippean visibles por default (defaultEnabled) — B5-4: las verticales ocultas
      // (ambulancia/grúa/mecánico/EV) NUNCA se filtran al quote aunque el catálogo esté caído.
      .filter((offering) =>
        effective === null ? offering.defaultEnabled : effective.has(offering.id),
      )
      .map((offering) => {
        const ov = effective?.get(offering.id);
        const pricing = ov?.pricing ?? offering.pricing; // efectivo (admin) o de código (degradación)
        // B5-1.d · FLIP: con el modelo de energía activo, precio por oferta con energía pass-through
        // (energyPerKm por fuente); con el flag OFF, la fórmula vieja (fuel global). Mismo motor que el create.
        const priceCents = this.offeringPriceCents(
          offering,
          pricing,
          route,
          fuelPerKmCents,
          energyPrices,
        );
        // B2 · modo POR oferta = pin del admin (si ∈ allowedModes) > schedule ∩ oferta. Mismo motor que create.
        const offeringMode = resolveOfferingModeWithPin(offering, ov?.modePin, scheduledMode).mode;
        return {
          id: offering.id,
          // Compat apps viejas: el server sigue resolviendo el nombre; las nuevas usan `labelKey` (i18n).
          name: OFFERING_DISPLAY_NAMES[offering.id],
          // Ola 2B: la clase de vehículo de la oferta (la app la usa para mostrar y para crear el viaje).
          vehicleType: offering.vehicleClass,
          // ETA del trayecto (mismo recorrido para todas las ofertas).
          etaSeconds: route.durationSeconds,
          priceCents,
          // Lote C3 · crédito que se aplicaría a ESTA tarifa: min(saldo, priceCents). Server-side, ≤ precio.
          creditAppliedCents: Math.min(creditBalanceCents, priceCents),
          currency: 'PEN' as const,
          mode: offeringMode,
          // ADR 013 (A2 · additive) · per-oferta PUJA: piso + sugerido PROPIOS. El sugerido es la tarifa que
          // SERÍA fija de ESTA oferta (= su priceCents, ya calculado con SU multiplier) — antes era SIEMPRE
          // el del ancla VEO Económico (bug: en Moto/Confort anclaba al precio del auto). El piso es per-OFERTA
          // (ADR 010 §9.3): config del admin resuelta con el MISMO resolver que el gate autoritativo de
          // trip-service (consistencia quote↔create por construcción). Solo para DISPLAY; el autoritativo lo
          // re-resuelve trip-service en createTrip (la app no lo manda).
          ...(isPujaMode(offeringMode)
            ? {
                bidFloorCents: resolveBidFloorCents(bidFloorConfig, GLOBAL_ZONE, offering.id),
                suggestedCents: priceCents,
              }
            : {}),
          labelKey: offering.labelKey,
          icon: offering.icon,
        };
      });

    // B5-1.b · shadow-compare del quote (log-only): mide el delta viejo↔nuevo sin cambiar lo que se muestra.
    this.logQuoteFareShadow(energyPrices, route, effective, fuelPerKmCents);

    const base: QuoteResult = {
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      geometry: route.geometry,
      options,
      mode,
    };

    if (isPujaMode(mode)) {
      // El ancla sugerida es la tarifa que SERÍA fija con la oferta base (VEO Económico): mismo cálculo
      // determinista que el modo fijo. B2: con el pricing EFECTIVO del ancla (overlay del admin) si existe.
      const anchorPricing = effective?.get(ANCHOR_OFFERING.id)?.pricing ?? ANCHOR_OFFERING.pricing;
      const suggestedCents = this.offeringPriceCents(
        ANCHOR_OFFERING,
        anchorPricing,
        route,
        fuelPerKmCents,
        energyPrices,
      );
      // El piso top-level (compat apps viejas) = el de la oferta ANCLA (VEO Económico), mismo resolver.
      const bidFloorCents = resolveBidFloorCents(bidFloorConfig, GLOBAL_ZONE, ANCHOR_OFFERING.id);
      return { ...base, bidFloorCents, suggestedCents };
    }
    return base;
  }

  /**
   * ADR 013 · seam de las ofertas cotizables. Delegación PURA en el catálogo (`OFFERING_LIST`, ya
   * ordenado por `sortOrder`). `protected` a propósito: los specs de la intersección oferta×schedule
   * (§1.3) subclasean el servicio para inyectar una oferta restringida (solo-FIXED) — el catálogo
   * real aún no tiene ofertas con `allowedModes ≠ [PUJA, FIXED]` y NO se inventa una entrada
   * fantasma en producción (mismo seam que `TripsService.resolveOffering`).
   */
  protected quotedOfferings(): readonly OfferingSpec[] {
    return OFFERING_LIST;
  }

  /**
   * Resuelve el modo de pricing del origen vía trip-service (GET /internal/pricing/resolve?lat&lon).
   * DEGRADACIÓN HONESTA (ADR 011 §8.2): si la llamada falla, devuelve PUJA (el default ratificado del
   * sistema) — NUNCA asume FIXED, porque mostrar un precio fijo que no podemos confirmar sería deshonesto
   * (el pasajero creería un precio firme inexistente). Ante la duda, puja: la app pide la oferta.
   */
  private async resolveMode(
    lat: number,
    lon: number,
    identity: AuthenticatedUser,
    at?: string,
  ): Promise<PricingMode> {
    try {
      // S2 — `at` (hora de recojo de una reserva) se reenvía a trip-service para resolver el modo de esa
      // hora; si no hay reserva, se omite y trip-service resuelve con `now`.
      const reply = await this.tripRest.get<ResolveModeReply>('/internal/pricing/resolve', {
        identity,
        query: at ? { lat, lon, at } : { lat, lon },
      });
      return reply.mode;
    } catch (err) {
      this.logger.warn(
        `resolve de modo falló (${(err as Error).message}); degradando a PUJA (ADR 011 §8.2)`,
      );
      return PricingModeEnum.PUJA;
    }
  }

  /**
   * B3 · recargo de combustible por km vigente (céntimos PEN) desde trip-service. DEGRADACIÓN HONESTA: si
   * la llamada falla → 0 (sin recargo) — el preview muestra la tarifa base, NUNCA un precio inventado.
   * Mismo criterio que el modo degradando a PUJA: el quote es informativo, el autoritativo es el create.
   */
  private async fetchFuelPerKmCents(identity: AuthenticatedUser): Promise<number> {
    try {
      const reply = await this.tripRest.get<FuelSurchargeReply>(
        '/internal/pricing/fuel-surcharge',
        {
          identity,
        },
      );
      return reply.perKmCents;
    } catch (err) {
      this.logger.warn(
        `recargo de combustible no disponible (${(err as Error).message}); preview sin recargo (B3 · degradación honesta)`,
      );
      return 0;
    }
  }

  /**
   * B5-1 · precios de energía por fuente (céntimos/unidad) del EnergyCatalog del admin, para el
   * shadow-compare del quote (y, post-flip, la tarifa autoritativa). `null` = no disponible → el shadow
   * se saltea (degradación honesta, no rompe el quote). Map<sourceId, pricePerUnitCents>.
   */
  private async fetchEnergyPrices(
    identity: AuthenticatedUser,
  ): Promise<Map<string, number> | null> {
    try {
      const reply = await this.tripRest.get<EnergyCatalogReply>(
        '/internal/pricing/energy-catalog',
        {
          identity,
        },
      );
      return new Map(reply.sources.map((s) => [s.sourceId, s.pricePerUnitCents]));
    } catch (err) {
      this.logger.warn(
        `catálogo de energía no disponible (${(err as Error).message}); shadow B5-1 salteado`,
      );
      return null;
    }
  }

  /**
   * ADR 010 §9.3 · config del piso de la PUJA (default + overrides por oferta) desde trip-service, para el
   * DISPLAY del quote. DEGRADACIÓN HONESTA: si la llamada falla → DEFAULT_BID_FLOOR_CONFIG (piso S/7, sin
   * overrides) — el quote muestra el piso por defecto, NUNCA un valor inventado. El autoritativo lo
   * re-resuelve trip-service en createTrip; acá es solo lo que la app muestra en "proponé tu precio".
   */
  private async fetchBidFloorConfig(identity: AuthenticatedUser): Promise<BidFloorConfig> {
    try {
      const reply = await this.tripRest.get<BidFloorReply>('/internal/pricing/bid-floor', {
        identity,
      });
      // El resolver (shared-types) ya tolera overrides con ids/zonas desconocidos (los ignora al buscar);
      // pasamos la forma tal cual viene del contrato interno.
      return {
        defaultFloorCents: reply.defaultFloorCents,
        overrides: reply.overrides as BidFloorConfig['overrides'],
      };
    } catch (err) {
      this.logger.warn(
        `piso de puja no disponible (${(err as Error).message}); quote con piso por defecto (ADR 010 §9.3 · degradación honesta)`,
      );
      return DEFAULT_BID_FLOOR_CONFIG;
    }
  }

  /**
   * B5-1.b · SHADOW-COMPARE del quote (NO cambia el precio mostrado). Por cada oferta cotizada computa el
   * delta viejo↔nuevo (energía pass-through derivada del EnergyCatalog por la fuente de la oferta) y loguea
   * UNA línea agregada. Mide el impacto del flip con muchas más muestras que el create. Degrada honesto:
   * sin precios de energía → no loguea. Solo computa para las ofertas FIXED del quote (en PUJA el bid manda).
   */
  private logQuoteFareShadow(
    energyPrices: Map<string, number> | null,
    route: { distanceMeters: number; durationSeconds: number },
    effective: Map<string, EffectiveOffering> | null,
    oldFuelPerKmCents: number,
  ): void {
    if (!energyPrices) return;
    const deltas = this.quotedOfferings()
      .filter((offering) => effective === null || effective.has(offering.id))
      .map((offering) => {
        const pricing = effective?.get(offering.id)?.pricing ?? offering.pricing;
        const energyPrice = energyPrices.get(offering.referenceEnergySourceId);
        const energyPerKm =
          energyPrice === undefined
            ? 0
            : deriveEnergyPerKmCents(energyPrice, offering.referenceEfficiency);
        const d = shadowCompareCategoryFare(
          route.distanceMeters,
          route.durationSeconds,
          pricing.multiplier,
          pricing.minFareCents,
          oldFuelPerKmCents,
          energyPerKm,
        );
        return `${offering.id}:${d.oldCents}→${d.newCents}(${d.deltaCents >= 0 ? '+' : ''}${d.deltaCents})`;
      });
    if (deltas.length > 0) {
      this.logger.log(`B5-1 quote-shadow (sin flip) · ${deltas.join(' ')}`);
    }
  }

  /**
   * B5-1.d · precio de una oferta para el quote. Con el FLIP activo usa la fórmula NUEVA (energía
   * pass-through por fuente, multiplier solo posición); con el flag OFF, la vieja (fuel global plegado).
   * Espejo EXACTO del create (trip-service) → consistencia quote↔create por construcción.
   */
  private offeringPriceCents(
    offering: OfferingSpec,
    pricing: OfferingPricingPolicy,
    route: { distanceMeters: number; durationSeconds: number },
    fuelPerKmCents: number,
    energyPrices: Map<string, number> | null,
  ): number {
    if (this.energyModelEnabled) {
      const energyPerKm = deriveEnergyPerKmCents(
        energyPrices?.get(offering.referenceEnergySourceId) ?? 0,
        offering.referenceEfficiency,
      );
      return categoryFareCentsV2(
        route.distanceMeters,
        route.durationSeconds,
        pricing.multiplier,
        pricing.minFareCents,
        energyPerKm,
      );
    }
    return categoryFareCents(
      route.distanceMeters,
      route.durationSeconds,
      pricing.multiplier,
      pricing.minFareCents,
      fuelPerKmCents,
    );
  }

  /**
   * B1c · ids de las ofertas ACTIVAS (overlay del admin, vía trip-service GET /internal/catalog). El quote
   * filtra `quotedOfferings()` por este set. DEGRADACIÓN HONESTA: si el catálogo no está disponible,
   * devuelve `null` → el quote cotiza TODAS las ofertas (no romper el pedido por una lectura de config;
   * mismo criterio que `resolveMode` degradando a PUJA).
   */
  /**
   * Catálogo EFECTIVO del admin para el quote: Map id → { pricing, modePin } SOLO de las ofertas
   * HABILITADAS (presencia en el map = activa). `null` = catálogo no disponible → el quote cotiza TODAS
   * con el pricing/modo de CÓDIGO (degradación honesta, como el modo degrada a PUJA). B2: trae el pricing
   * efectivo + el pin de modo para que el quote MUESTRE lo que createTrip va a cobrar/usar (cierra el gap
   * quote↔create).
   */
  private async fetchEffectiveCatalog(
    identity: AuthenticatedUser,
  ): Promise<Map<string, EffectiveOffering> | null> {
    try {
      const reply = await this.tripRest.get<CatalogReply>('/internal/catalog', { identity });
      return new Map(
        reply.offerings
          .filter((o) => o.enabled)
          .map((o) => [o.id, { pricing: o.pricing, modePin: o.modePin }]),
      );
    } catch (err) {
      this.logger.warn(
        `catálogo no disponible (${(err as Error).message}); cotizando todas las ofertas con pricing de código (B2 · degradación honesta)`,
      );
      bumpCatalogDegraded('quote');
      return null;
    }
  }

  /**
   * B1c · catálogo ACTIVO para la teaser del Home (sin ruta: el "menú" de servicios). Solo las ofertas
   * habilitadas, con sus tokens de display (la app resuelve labelKey/icon en su i18n/registro). DEGRADACIÓN
   * HONESTA: si trip-service no responde, devolvemos el catálogo de CÓDIGO completo (`OFFERING_LIST`) — la
   * teaser es informativa; mostrar el menú base es mejor que una pantalla vacía por una config caída.
   */
  async catalog(identity: AuthenticatedUser = ANONYMOUS_IDENTITY): Promise<CatalogResult> {
    try {
      const reply = await this.tripRest.get<CatalogReply>('/internal/catalog', { identity });
      return {
        offerings: reply.offerings
          .filter((o) => o.enabled)
          .map((o) => ({
            id: o.id,
            name: OFFERING_DISPLAY_NAMES[o.id],
            labelKey: o.labelKey,
            icon: o.icon,
            vehicleType: o.vehicleClass,
          })),
      };
    } catch (err) {
      this.logger.warn(
        `catálogo no disponible para la teaser (${(err as Error).message}); devolviendo el catálogo de código (degradación honesta)`,
      );
      bumpCatalogDegraded('teaser');
      return {
        // B5-4: en degradación mostramos SOLO las ofertas visibles por default (las 3 RIDE + moto), NO las
        // verticales ocultas — mostrar el menú base es honesto; filtrar una ambulancia sin confirmar que el
        // admin la habilitó, también.
        offerings: OFFERING_LIST.filter((o) => o.defaultEnabled).map((o) => ({
          id: o.id,
          name: OFFERING_DISPLAY_NAMES[o.id],
          labelKey: o.labelKey,
          icon: o.icon,
          vehicleType: o.vehicleClass,
        })),
      };
    }
  }

  /**
   * Saldo de crédito GASTABLE del pasajero para el PREVIEW del quote (Lote C3). Server-side (§INTEGRACIONES:
   * el monto del crédito lo computa el server, no la app). Devuelve 0 — sin romper el quote — cuando:
   *  - el quote es ANÓNIMO (sin user) o sin userId;
   *  - no se inyectó el cliente gRPC / el secreto (tests que construyen el service con 3 args);
   *  - la lectura del saldo falla (degradación honesta: el crédito es secundario a la ruta; el recibo
   *    muestra el aplicado real al cobrar).
   */
  private async fetchCreditBalance(identity: AuthenticatedUser): Promise<number> {
    if (
      !this.paymentGrpc ||
      !this.secret ||
      !this.audience ||
      identity === ANONYMOUS_IDENTITY ||
      !identity.userId
    ) {
      return 0;
    }
    try {
      const meta = grpcIdentityMetadata(identity, this.secret, this.audience);
      const reply = await this.paymentGrpc.call<UserCreditReply>(
        'GetUserCredit',
        { userId: identity.userId },
        meta,
      );
      return reply.balanceCents;
    } catch (err) {
      this.logger.warn(
        `credit fetch para el quote falló (${(err as Error).message}); quote sin preview de crédito`,
      );
      return 0;
    }
  }

  /** Mapea un GeocodeResult a una sugerencia con id estable y título/subtítulo separados. */
  private toPlaceSuggestion(result: GeocodeResult): PlaceSuggestion {
    const { title, subtitle } = this.splitLabel(result);
    return {
      id: `${result.lat.toFixed(6)},${result.lon.toFixed(6)}`,
      title,
      subtitle,
      lat: result.lat,
      lng: result.lon,
    };
  }

  /**
   * Deriva título (lugar) y subtítulo (resto de la dirección) del resultado de Nominatim.
   * Usa `name` si viene; si no, toma el primer segmento del `displayName`.
   */
  private splitLabel(result: GeocodeResult): { title: string; subtitle: string } {
    const display = result.displayName ?? '';
    const parts = display
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    const name = result.name?.trim();
    const title = name && name.length > 0 ? name : (parts[0] ?? display);
    const subtitle = parts.filter((part) => part !== title).join(', ');
    return { title, subtitle };
  }
}
