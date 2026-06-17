import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import type { GeoJsonLineString } from '@veo/maps';

/** Máximo de paradas intermedias en la cotización (Ola 2B · espeja el límite de trip-service). */
export const MAX_QUOTE_WAYPOINTS = 3;

/**
 * Punto geográfico de la API pública de mapas. Usa `lng` (convención MapLibre/Google que ya emplea
 * la app móvil para el mapa), distinto del `lon` interno de @veo/maps; el service hace la conversión.
 */
export class MapPointDto {
  @ApiProperty({ example: -12.0464 })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -77.0428 })
  @Type(() => Number)
  @IsLongitude()
  lng!: number;
}

/** GET /maps/autocomplete?q=&lat=&lng= */
export class AutocompleteQueryDto {
  @ApiProperty({ example: 'Av. Larco', description: 'Texto parcial a autocompletar' })
  @IsString()
  @MaxLength(120)
  q!: string;

  @ApiPropertyOptional({ example: -12.1211, description: 'Latitud para sesgar por proximidad' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({ example: -77.0297, description: 'Longitud para sesgar por proximidad' })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lng?: number;
}

/** GET /maps/reverse?lat=&lng= */
export class ReverseQueryDto {
  @ApiProperty({ example: -12.0464 })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -77.0428 })
  @Type(() => Number)
  @IsLongitude()
  lng!: number;
}

/** POST /maps/quote body. */
export class QuoteRequestDto {
  @ApiProperty({ type: MapPointDto })
  @ValidateNested()
  @Type(() => MapPointDto)
  origin!: MapPointDto;

  @ApiProperty({ type: MapPointDto })
  @ValidateNested()
  @Type(() => MapPointDto)
  destination!: MapPointDto;

  @ApiPropertyOptional({
    type: [MapPointDto],
    description: 'Paradas intermedias ordenadas (Ola 2B, máx 3). La cotización las incluye en la ruta.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_QUOTE_WAYPOINTS)
  @ValidateNested({ each: true })
  @Type(() => MapPointDto)
  waypoints?: MapPointDto[];

  /**
   * S2 (ADR 011) — hora de RECOJO de una reserva (ISO-8601, opcional). Si se envía, el quote resuelve el
   * modo de pricing para ESA hora (no la actual) → el preview de una reserva muestra la política de la hora
   * de recojo. Omitir = viaje inmediato (modo de ahora). Es solo un preview; el modo se congela en POST /trips.
   */
  @ApiPropertyOptional({
    description: 'Hora de recojo de una reserva (ISO-8601). El quote resuelve el modo para esa hora (S2).',
    example: '2026-06-01T22:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  scheduledFor?: string;
}

/* ── Formas de respuesta (espejan los contratos de @veo/api-client) ── */

/** Sugerencia de dirección del autocompletado. */
export interface PlaceSuggestion {
  id: string;
  title: string;
  subtitle: string;
  lat: number;
  lng: number;
}

/** Etiqueta de un punto (reverse geocoding). */
export interface ReversePlace {
  title: string;
  subtitle: string;
  lat: number;
  lng: number;
}

/** Opción de viaje cotizada (una por oferta del catálogo, ADR 013). */
export interface QuoteOption {
  id: string;
  /** Nombre resuelto server-side (compat apps viejas; las nuevas resuelven `labelKey` en su i18n). */
  name: string;
  /** Clase de vehículo de la oferta (wire field histórico, Ola 2B): 'CAR' | 'MOTO'. */
  vehicleType: 'CAR' | 'MOTO';
  etaSeconds: number;
  priceCents: number;
  /**
   * Crédito de referido (Ola 2A · Lote C3) que se aplicaría a ESTA opción: `min(saldo, priceCents)`,
   * computado SERVER-side (§INTEGRACIONES: el dinero no se calcula en el cliente). 0 si el pasajero no
   * tiene saldo o el quote es anónimo. PREVIEW sobre la tarifa cotizada: si al cobrar hay una promo, el
   * crédito real puede ser menor (la promo baja la base primero); el recibo muestra el aplicado real.
   */
  creditAppliedCents: number;
  currency: 'PEN';
  /**
   * ADR 013 §1.3 (additive) · modo RESUELTO POR OFERTA: `offering.allowedModes ∩ schedule`. Le dice a
   * la app qué pantalla pintar (puja vs precio firme) POR opción; el `mode` top-level se mantiene
   * (compat, ancla VEO Económico).
   */
  mode: PricingMode;
  /** ADR 013 (additive) · token i18n del nombre (`offering.veo_moto.name`); la app lo resuelve. */
  labelKey: string;
  /** ADR 013 (additive) · token de ícono (`car` | `moto`) que la app resuelve en su registro token→glyph. */
  icon: string;
  /**
   * ADR 013 (A2 · additive) · SOLO si la oferta resuelve PUJA: piso de la zona (céntimos PEN), para
   * DISPLAY. El autoritativo lo re-resuelve trip-service en createTrip (la app no lo envía). Ausente en
   * FIXED. DEUDA: hoy es el piso global único; per-oferta/per-zona = Tier 2 (ADR 011 §9.3).
   */
  bidFloorCents?: number;
  /**
   * ADR 013 (A2 · additive) · SOLO si la oferta resuelve PUJA: sugerido = la tarifa que sería fija DE
   * ESTA oferta (= su `priceCents`). Ausente en FIXED.
   */
  suggestedCents?: number;
}

/**
 * Modo de pricing/despacho resuelto por el servidor (ADR 011). Espeja `PricingMode` de
 * @veo/shared-types (PUJA | FIXED). Decide la pantalla que muestra la app pasajero.
 */
export type PricingMode = 'PUJA' | 'FIXED';

/**
 * Cotización ligera de previsualización: ruta + ETA + opciones de tarifa + modo de pricing (ADR 011 M4).
 * `mode` lo resuelve trip-service (GET /internal/pricing/resolve); la app pinta la pantalla según él:
 *  - FIXED → usa `options[].priceCents` (precio firme por categoría).
 *  - PUJA  → usa `bidFloorCents` (piso de la zona) + `suggestedCents` (ancla = la tarifa que sería fija).
 * `bidFloorCents`/`suggestedCents` solo se envían en modo PUJA.
 */
export interface QuoteResult {
  distanceMeters: number;
  durationSeconds: number;
  geometry: GeoJsonLineString;
  options: QuoteOption[];
  mode: PricingMode;
  bidFloorCents?: number;
  suggestedCents?: number;
}

/** Una oferta del catálogo para la teaser del Home (B1c): tokens de display, sin ruta/precio. */
export interface OfferingTeaserItem {
  id: string;
  /** Nombre resuelto server-side (compat apps viejas; las nuevas resuelven `labelKey`). */
  name: string;
  /** Token i18n del nombre (`offering.veo_moto.name`). */
  labelKey: string;
  /** Token de ícono (`car` | `moto`) que la app resuelve en su registro token→glyph. */
  icon: string;
  /** Clase de vehículo (wire histórico): 'CAR' | 'MOTO'. */
  vehicleType: 'CAR' | 'MOTO';
}

/** GET /maps/catalog → catálogo ACTIVO (solo ofertas habilitadas por el admin). Sin ruta. */
export interface CatalogResult {
  offerings: OfferingTeaserItem[];
}
