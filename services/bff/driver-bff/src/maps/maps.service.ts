/**
 * Búsqueda de LUGARES del CONDUCTOR (autocomplete + reverse-geocode). ESPEJA el dominio de mapas del
 * pasajero (public-bff `maps.service`), pero para el driver-rail: habla con la infra soberana
 * OSRM/Nominatim vía la fachada @veo/maps (self-hosted, §0.7). NO proxya a places-service (ese es CRUD
 * de lugares GUARDADOS por gRPC, no geocoding). El cliente MAPS ya está cableado en CoreModule (@Global),
 * el mismo que trips.service usa para rutear — acá lo reusamos para búsqueda de direcciones.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '@veo/utils';
import type { GeocodeResult, MapsClient } from '@veo/maps';
import { MAPS } from '../infra/maps.client';
import type { PlaceSuggestion, ReversePlace } from './dto/maps.dto';

/** Longitud mínima del texto para disparar el autocompletado (evita ruido/costos). Espeja al pasajero. */
const MIN_QUERY_LENGTH = 3;

@Injectable()
export class MapsService {
  constructor(@Inject(MAPS) private readonly maps: MapsClient) {}

  /**
   * Autocompletado de direcciones. Devuelve `[]` si el texto es muy corto (<3) o no hay resultados.
   * Si llegan `lat/lng`, sesga las sugerencias por proximidad (`near`).
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
