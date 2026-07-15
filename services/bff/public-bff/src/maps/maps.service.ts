/**
 * Dominio de mapas del pasajero (UX de previsualización antes de confirmar el viaje).
 * Habla con la infra soberana OSRM/Nominatim vía la fachada @veo/maps; y con trip-service para leer el
 * catálogo EFECTIVO (pricing + modo POR oferta), no para crear viajes.
 * - autocomplete: sugerencias de direcciones (Nominatim).
 * - reverse: etiqueta del punto actual ("Tu ubicación").
 * - quote: ruta + ETA + tarifa por categoría (OSRM + cálculo determinista local) + modo PUJA/FIXED.
 *
 * ADR 023: el MODO de pricing lo manda la OFERTA (palanca manual del admin), NO el horario ni el cliente
 * (ADR 011 schedule/franjas superseded). El quote lee el `mode` EFECTIVO por oferta del catálogo
 * (`/internal/catalog`, ya resuelto por trip-service con `effectiveOfferingMode`); en degradación
 * (catálogo caído) cae al `mode` de CÓDIGO de la oferta (`effectiveOfferingMode(offering)`).
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
  effectiveOfferingMode,
  OFFERING_LIST,
  OFFERINGS,
  OfferingId,
  resolveBidFloorCents,
  DEFAULT_BID_FLOOR_CONFIG,
  MIN_SURGE,
  MAX_SURGE,
  type BidFloorConfig,
  type OfferingSpec,
  type OfferingPricingPolicy,
} from '@veo/shared-types';
import { GRPC_PAYMENT, MAPS, REST_TRIP } from '../infra/downstream.tokens';
import { ANONYMOUS_IDENTITY } from '../common/identities';
import type { UserCreditReply } from '../infra/grpc-types';
import type { Env } from '../config/env.schema';
import { categoryFareCents, DEFAULT_FARE_BASE, type FareBase } from './fare';
import { DispatchService } from '../dispatch/dispatch.service';
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
 * de la PUJA (la tarifa que SERÍA fija con la oferta base) y su modo EFECTIVO es el `mode` top-level
 * (compat con apps viejas que no leen `options[].mode`).
 */
const ANCHOR_OFFERING = OFFERINGS[OfferingId.VEO_ECONOMICO];

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
    // ADR 023: pricing + `mode` EFECTIVOS (overlay del admin ⟕ código). El `mode` YA lo resolvió
    // trip-service con `effectiveOfferingMode` (palanca manual del admin, respetando `modeLocked`).
    pricing: OfferingPricingPolicy;
    mode: PricingMode;
  }[];
}

/** Estado configurable EFECTIVO de una oferta (overlay del admin) que el quote aplica sobre la base de código. */
interface EffectiveOffering {
  pricing: OfferingPricingPolicy;
  mode: PricingMode;
}

@Injectable()
export class MapsService {
  private readonly logger = new Logger(MapsService.name);

  constructor(
    @Inject(MAPS) private readonly maps: MapsClient,
    @Inject(REST_TRIP) private readonly tripRest: InternalRestClient,
    config: ConfigService<Env, true>,
    // Opcionales (DI): preview de crédito de referido en el quote (Lote C3). Trailing + @Optional para no
    // romper los specs que construyen/subclasean el servicio con 3 args; sin ellos el quote no trae preview.
    @Optional() @Inject(GRPC_PAYMENT) private readonly paymentGrpc?: GrpcServiceClient,
    @Optional() @Inject(INTERNAL_IDENTITY_SECRET) private readonly secret?: string,
    @Optional() @Inject(INTERNAL_IDENTITY_AUDIENCE) private readonly audience?: InternalAudience,
    // ADR-021 Fase C · surge autoritativo para el preview (mismo getSurge que usa createTrip). @Optional
    // trailing: los specs que construyen el servicio con menos args no lo pasan → el quote degrada a 1.0.
    @Optional() private readonly dispatch?: DispatchService,
  ) {}

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
    // La ruta, el crédito y el catálogo activo son independientes → en paralelo. ADR 023: el modo YA NO
    // se resuelve aparte (no hay schedule/franjas): sale del catálogo EFECTIVO, por oferta. ADR-021 Fase C:
    // el surge AUTORITATIVO se resuelve server-side (mismo dispatch.getSurge que el create) y se paraleliza.
    const [route, creditBalanceCents, effective, bidFloorConfig, fareBase, surgeMultiplier] =
      await Promise.all([
      this.maps.route(origin, destination, waypoints),
      // Lote C3 · saldo de crédito de referido para el PREVIEW (server-side, §INTEGRACIONES). 0 si anónimo/
      // sin cliente/error (no rompe el quote: el crédito es secundario a la ruta).
      this.fetchCreditBalance(identity),
      // ADR 023 · catálogo EFECTIVO del admin (habilitadas + pricing + `mode` por oferta). `null` = no
      // disponible → cotizamos TODAS con pricing/modo de CÓDIGO (degradación honesta).
      this.fetchEffectiveCatalog(identity),
      // ADR 010 §9.3 · config del piso de la PUJA per-(zona, oferta) para el DISPLAY del quote. Degradación
      // honesta: trip-service caído → DEFAULT_BID_FLOOR_CONFIG (piso S/7). El autoritativo lo re-resuelve
      // trip-service en createTrip — acá es solo el piso que la app MUESTRA en "proponé tu precio".
      this.fetchBidFloorConfig(identity),
      // F2.4 · banderazo/km/min vigentes (admin). Degradación honesta: trip-service caído → constantes de
      // código (= el seed) → el preview no diverge del cobro en el caso común.
      this.fetchBaseFare(identity),
      // ADR-021 Fase C · surge AUTORITATIVO server-side para el preview FIXED (mismo dispatch.getSurge que
      // createTrip, sobre el ORIGEN). Cierra el sobrecobro silencioso quote↔create. Degradación honesta:
      // dispatch caído/anónimo → 1.0 (sin surge, jamás sobre-cotiza).
      this.fetchSurge(identity, origin),
    ]);

    // ADR 023 · el `mode` top-level = el modo EFECTIVO de la oferta ANCLA (VEO Económico), tal cual lo
    // resolvió trip-service en el catálogo (palanca manual del admin). Catálogo caído / ancla apagada →
    // el modo de CÓDIGO de la oferta (`effectiveOfferingMode`), NO un default global.
    const mode = effective?.get(ANCHOR_OFFERING.id)?.mode ?? effectiveOfferingMode(ANCHOR_OFFERING);

    // Las opciones SALEN del catálogo (ADR 013): OFFERING_LIST (código = estructura) ya ordenado por
    // sortOrder. El overlay del admin aporta enabled (filtro) + pricing + `mode` EFECTIVOS — el MISMO
    // contrato que createTrip (degradación honesta: catálogo caído → pricing/modo de código).
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
        // ADR 023 · modo POR oferta = el `mode` EFECTIVO del catálogo (palanca del admin, ya resuelto por
        // trip-service) o, en degradación, el de CÓDIGO de la oferta. Mismo criterio que createTrip.
        const offeringMode = ov?.mode ?? effectiveOfferingMode(offering);
        // ADR-021 Fase C · el surge autoritativo aplica SOLO a la tarifa FIJA: en PUJA el bid ES el precio
        // (surge irrelevante) — espeja createTrip, que resuelve surge solo cuando `bidCents == null`. Así el
        // preview FIXED muestra lo que el create va a cobrar y la sugerida de PUJA no infla con surge.
        const offeringSurge = isPujaMode(offeringMode) ? MIN_SURGE : surgeMultiplier;
        // Precio por oferta: base + km + min × multiplier × surge, con mínima. Mismo motor que el create.
        const priceCents = this.offeringPriceCents(pricing, route, fareBase, offeringSurge);
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
                bidFloorCents: resolveBidFloorCents(bidFloorConfig, offering.id),
                suggestedCents: priceCents,
              }
            : {}),
          labelKey: offering.labelKey,
          icon: offering.icon,
        };
      });

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
      const suggestedCents = this.offeringPriceCents(anchorPricing, route, fareBase);
      // El piso top-level (compat apps viejas) = el de la oferta ANCLA (VEO Económico), mismo resolver.
      const bidFloorCents = resolveBidFloorCents(bidFloorConfig, ANCHOR_OFFERING.id);
      return { ...base, bidFloorCents, suggestedCents };
    }
    return base;
  }

  /**
   * ADR 013 · seam de las ofertas cotizables. Delegación PURA en el catálogo (`OFFERING_LIST`, ya
   * ordenado por `sortOrder`). `protected` a propósito: es el punto de extensión para que un spec
   * subclase el servicio e inyecte un catálogo de ofertas de prueba sin inventar una entrada fantasma
   * en producción (mismo seam que `TripsService.resolveOffering`).
   */
  protected quotedOfferings(): readonly OfferingSpec[] {
    return OFFERING_LIST;
  }

  /**
   * ADR-021 Fase C · resuelve el surge AUTORITATIVO para el preview FIXED, con el MISMO `dispatch.getSurge`
   * que usa createTrip (sobre el ORIGEN). Cierra el sobrecobro silencioso: antes el quote NO aplicaba surge
   * y el create SÍ, así que bajo demanda alta el pasajero veía un precio y se le cobraba otro mayor.
   * DEGRADACIÓN HONESTA (nunca rompe el quote ni sobre-cotiza): sin cliente dispatch (specs) / identidad
   * anónima / dispatch caído → 1.0 (sin recargo). El valor se clampa a [MIN_SURGE, MAX_SURGE] por defensa.
   */
  private async fetchSurge(
    identity: AuthenticatedUser,
    origin: { lat: number; lon: number },
  ): Promise<number> {
    if (!this.dispatch || identity === ANONYMOUS_IDENTITY) return MIN_SURGE;
    try {
      const { multiplier } = await this.dispatch.getSurge(identity, origin.lat, origin.lon);
      if (!Number.isFinite(multiplier)) return MIN_SURGE;
      return Math.min(Math.max(multiplier, MIN_SURGE), MAX_SURGE);
    } catch (err) {
      this.logger.warn(
        `surge no disponible en el quote (${(err as Error).message}); preview sin surge (degradación honesta)`,
      );
      return MIN_SURGE;
    }
  }

  /**
   * F2.4 · banderazo/km/min vigentes (céntimos PEN) desde trip-service. DEGRADACIÓN HONESTA: si la llamada
   * falla → las constantes de código (= el seed) — el preview cobra lo de siempre, NUNCA un precio inventado
   * ni 0 (0 = viajes gratis). El quote es informativo; el autoritativo es el create.
   */
  private async fetchBaseFare(identity: AuthenticatedUser): Promise<FareBase> {
    try {
      const reply = await this.tripRest.get<FareBase>('/internal/pricing/base-fare', { identity });
      // No confiamos en el shape del reply interno: un 200 malformado (campo faltante/no-numérico)
      // propagaría NaN al precio. Degradamos a las constantes (= el seed) — nunca un precio inventado.
      if (
        !Number.isFinite(reply.baseFareCents) ||
        !Number.isFinite(reply.perKmCents) ||
        !Number.isFinite(reply.perMinCents)
      ) {
        this.logger.warn(
          'tarifa base con shape inválido; preview con tarifa base de código (F2.4)',
        );
        return DEFAULT_FARE_BASE;
      }
      return {
        baseFareCents: reply.baseFareCents,
        perKmCents: reply.perKmCents,
        perMinCents: reply.perMinCents,
      };
    } catch (err) {
      this.logger.warn(
        `tarifa base no disponible (${(err as Error).message}); preview con tarifa base de código (F2.4 · degradación honesta)`,
      );
      return DEFAULT_FARE_BASE;
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
   * Precio de una oferta para el quote: BASE + km·POR_KM + min·POR_MIN, escalado por el multiplier de la
   * oferta y con su tarifa mínima. Espejo EXACTO del create (trip-service) → consistencia quote↔create.
   */
  private offeringPriceCents(
    pricing: OfferingPricingPolicy,
    route: { distanceMeters: number; durationSeconds: number },
    fareBase: FareBase,
    /** ADR-021 Fase C · surge autoritativo [1.0, 2.0]. Default 1.0 (PUJA / degradación). Solo FIXED lo recibe >1. */
    surgeMultiplier: number = MIN_SURGE,
  ): number {
    return categoryFareCents(
      route.distanceMeters,
      route.durationSeconds,
      pricing.multiplier,
      pricing.minFareCents,
      fareBase,
      surgeMultiplier,
    );
  }

  /**
   * Catálogo EFECTIVO del admin para el quote: Map id → { pricing, mode } SOLO de las ofertas
   * HABILITADAS (presencia en el map = activa). `null` = catálogo no disponible → el quote cotiza TODAS
   * con el pricing/modo de CÓDIGO (degradación honesta). ADR 023: trae el pricing + el `mode` EFECTIVOS
   * (ya resueltos por trip-service con la palanca del admin) para que el quote MUESTRE lo que createTrip
   * va a cobrar/usar (cierra el gap quote↔create).
   */
  private async fetchEffectiveCatalog(
    identity: AuthenticatedUser,
  ): Promise<Map<string, EffectiveOffering> | null> {
    try {
      const reply = await this.tripRest.get<CatalogReply>('/internal/catalog', { identity });
      return new Map(
        reply.offerings
          .filter((o) => o.enabled)
          .map((o) => [o.id, { pricing: o.pricing, mode: o.mode }]),
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
