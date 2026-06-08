/**
 * Dominio de mapas del pasajero (UX de previsualización antes de confirmar el viaje).
 * Habla con la infra soberana OSRM/Nominatim vía la fachada @veo/maps; y con trip-service SOLO para
 * resolver el MODO de pricing del quote (ADR 011 M4), no para crear viajes.
 * - autocomplete: sugerencias de direcciones (Nominatim).
 * - reverse: etiqueta del punto actual ("Tu ubicación").
 * - quote: ruta + ETA + tarifa por categoría (OSRM + cálculo determinista local) + modo PUJA/FIXED.
 */
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '@veo/auth';
import type { GeocodeResult, MapsClient } from '@veo/maps';
import { InternalRestClient } from '@veo/rpc';
import { MAPS, REST_TRIP } from '../infra/downstream.tokens';
import { ANONYMOUS_IDENTITY } from '../infra/internal-identity';
import type { Env } from '../config/env.schema';
import { categoryFareCents, minFareForCategory, RIDE_CATEGORIES } from './fare';
import {
  type PlaceSuggestion,
  type PricingMode,
  type QuoteRequestDto,
  type QuoteResult,
  type ReversePlace,
} from './dto/maps.dto';

/** Longitud mínima del texto para disparar el autocompletado (evita ruido/costos). */
const MIN_QUERY_LENGTH = 3;

/** Multiplicador de la categoría ancla (VEO Económico = 1.0) para el `suggestedCents` de la PUJA. */
const ANCHOR_MULTIPLIER = 1.0;

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
      throw new NotFoundException('No se encontró una dirección para el punto');
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
    const [route, mode] = await Promise.all([
      this.maps.route(origin, destination, waypoints),
      // S2 (ADR 011) — si el quote es de una RESERVA (scheduledFor), resolvemos el modo para la hora de
      // RECOJO, no la actual: el preview muestra la política de la hora a la que VA a viajar el pasajero.
      this.resolveMode(dto.origin.lat, dto.origin.lng, identity, dto.scheduledFor),
    ]);

    const options = RIDE_CATEGORIES.map((category) => ({
      id: category.id,
      name: category.name,
      // Ola 2B: el tipo de vehículo de la opción (la app lo usa para mostrar y para crear el viaje).
      vehicleType: category.vehicleType,
      // ETA del trayecto (mismo recorrido para todas las categorías).
      etaSeconds: route.durationSeconds,
      priceCents: categoryFareCents(
        route.distanceMeters,
        route.durationSeconds,
        category.multiplier,
        minFareForCategory(category.vehicleType),
      ),
      currency: 'PEN' as const,
    }));

    const base: QuoteResult = {
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      geometry: route.geometry,
      options,
      mode,
    };

    if (mode === 'PUJA') {
      // El ancla sugerida es la tarifa que SERÍA fija con la categoría base (VEO Económico, mult 1.0):
      // mismo cálculo determinista que el modo fijo, ofrecido como referencia del bid.
      const suggestedCents = categoryFareCents(
        route.distanceMeters,
        route.durationSeconds,
        ANCHOR_MULTIPLIER,
      );
      return { ...base, bidFloorCents: this.bidFloorCents, suggestedCents };
    }
    return base;
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
