/**
 * Dominio de mapas del pasajero (UX de previsualización antes de confirmar el viaje).
 * Habla con la infra soberana OSRM/Nominatim vía la fachada @veo/maps; y con trip-service SOLO para
 * resolver el MODO de pricing del quote (ADR 011 M4), no para crear viajes.
 * - autocomplete: sugerencias de direcciones (Nominatim).
 * - reverse: etiqueta del punto actual ("Tu ubicación").
 * - quote: ruta + ETA + tarifa por categoría (OSRM + cálculo determinista local) + modo PUJA/FIXED.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '@veo/auth';
import { NotFoundError } from '@veo/utils';
import type { GeocodeResult, MapsClient } from '@veo/maps';
import { InternalRestClient } from '@veo/rpc';
import {
  OFFERING_LIST,
  OFFERINGS,
  OfferingId,
  resolveOfferingMode,
  type OfferingSpec,
} from '@veo/shared-types';
import { MAPS, REST_TRIP } from '../infra/downstream.tokens';
import { ANONYMOUS_IDENTITY } from '../common/identities';
import type { Env } from '../config/env.schema';
import { categoryFareCents } from './fare';
import { OFFERING_DISPLAY_NAMES } from './offering-names';
import {
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

@Injectable()
export class MapsService {
  private readonly logger = new Logger(MapsService.name);
  private readonly bidFloorCents: number;

  constructor(
    @Inject(MAPS) private readonly maps: MapsClient,
    @Inject(REST_TRIP) private readonly tripRest: InternalRestClient,
    config: ConfigService<Env, true>,
  ) {
    // El schema da default 700 (espeja trip-service); getOrThrow es seguro y respeta la convención.
    this.bidFloorCents = config.getOrThrow<number>('BID_FLOOR_CENTS');
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
  async quote(dto: QuoteRequestDto, identity: AuthenticatedUser = ANONYMOUS_IDENTITY): Promise<QuoteResult> {
    const origin = { lat: dto.origin.lat, lon: dto.origin.lng };
    const destination = { lat: dto.destination.lat, lon: dto.destination.lng };
    // Ola 2B · paradas múltiples: la ruta (y por tanto distancia/duración/tarifa) pasa por las paradas.
    const waypoints = (dto.waypoints ?? []).map((w) => ({ lat: w.lat, lon: w.lng }));
    // La ruta y la resolución del modo son independientes → en paralelo (el modo usa el origen).
    const [route, scheduledMode] = await Promise.all([
      this.maps.route(origin, destination, waypoints),
      // S2 (ADR 011) — si el quote es de una RESERVA (scheduledFor), resolvemos el modo para la hora de
      // RECOJO, no la actual: el preview muestra la política de la hora a la que VA a viajar el pasajero.
      this.resolveMode(dto.origin.lat, dto.origin.lng, identity, dto.scheduledFor),
    ]);

    // ADR 013 §1.3 · el `mode` top-level mantiene su semántica: el modo de la oferta ANCLA (VEO
    // Económico). Hoy el ancla permite ambos modos → es el scheduledMode tal cual (no-op); si algún
    // día el ancla se restringiera, el top-level seguiría siendo honesto por construcción.
    const mode = resolveOfferingMode(ANCHOR_OFFERING, scheduledMode).mode;

    // Las opciones SALEN del catálogo (ADR 013): OFFERING_LIST ya viene ordenado por sortOrder.
    const options = this.quotedOfferings().map((offering) => ({
      id: offering.id,
      // Compat apps viejas: el server sigue resolviendo el nombre; las nuevas usan `labelKey` (i18n).
      name: OFFERING_DISPLAY_NAMES[offering.id],
      // Ola 2B: la clase de vehículo de la oferta (la app la usa para mostrar y para crear el viaje).
      vehicleType: offering.vehicleClass,
      // ETA del trayecto (mismo recorrido para todas las ofertas).
      etaSeconds: route.durationSeconds,
      priceCents: categoryFareCents(
        route.distanceMeters,
        route.durationSeconds,
        offering.pricing.multiplier,
        offering.pricing.minFareCents,
      ),
      currency: 'PEN' as const,
      // ADR 013 §1.3 (additive) · modo POR oferta = allowedModes ∩ schedule: la oferta acota al admin.
      mode: resolveOfferingMode(offering, scheduledMode).mode,
      labelKey: offering.labelKey,
      icon: offering.icon,
    }));

    const base: QuoteResult = {
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      geometry: route.geometry,
      options,
      mode,
    };

    if (mode === 'PUJA') {
      // El ancla sugerida es la tarifa que SERÍA fija con la oferta base (VEO Económico, mult 1.0):
      // mismo cálculo determinista que el modo fijo, alimentado por la política del catálogo.
      const suggestedCents = categoryFareCents(
        route.distanceMeters,
        route.durationSeconds,
        ANCHOR_OFFERING.pricing.multiplier,
        ANCHOR_OFFERING.pricing.minFareCents,
      );
      return { ...base, bidFloorCents: this.bidFloorCents, suggestedCents };
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
      return 'PUJA';
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
