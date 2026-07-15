/**
 * DTOs del carpooling del PASAJERO (ADR-014 · public-rail). Espejan los DTOs de booking-service
 * (SearchPublishedTripsDto / CreateBookingDto): el BFF valida en el borde y el downstream REVALIDA
 * (defensa en profundidad, misma regla que trips/payments). El `passengerId` NUNCA viaja en el body:
 * lo deriva la identidad firmada (server-truth, anti-IDOR).
 */
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaymentMethod } from '@veo/shared-types';
import { REGIONS_PE } from '@veo/utils';

/** Fecha-calendario PURA `YYYY-MM-DD` (sin hora ni offset) — booking-service la interpreta en hora Lima. */
const CALENDAR_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Órdenes de la búsqueda (espejo del downstream): `salida` (default) o `precio`. */
const SEARCH_ORDER_VALUES = ['salida', 'precio'] as const;
type SearchOrder = (typeof SEARCH_ORDER_VALUES)[number];

/** Hora-de-pared `HH:mm` (24h, cero-padded) — el downstream la interpreta en hora Lima dentro del día. */
const LIMA_WALL_TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export class SearchCarpoolTripsDto {
  // ── Ruta A→B que busca el pasajero. ──
  @Type(() => Number)
  @IsLatitude()
  originLat!: number;

  @Type(() => Number)
  @IsLongitude()
  originLon!: number;

  @Type(() => Number)
  @IsLatitude()
  destLat!: number;

  @Type(() => Number)
  @IsLongitude()
  destLon!: number;

  // Día de salida como fecha-calendario pura (el downstream corta datetime/offset con el mismo doble gate).
  @Matches(CALENDAR_DATE_REGEX, {
    message: 'fecha debe ser una fecha-calendario YYYY-MM-DD (sin hora ni offset)',
  })
  @IsISO8601({ strict: true })
  fecha!: string;

  // Asientos que necesita (la oferta debe tener disponibles >= este valor).
  @Type(() => Number)
  @IsInt()
  @Min(1)
  asientos!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  // Orden de la página: `salida` (default) o `precio` (más barato primero). Opcional — contrato intacto.
  @IsOptional()
  @IsIn(SEARCH_ORDER_VALUES)
  orden?: SearchOrder;

  // Precio máximo por asiento en céntimos PEN (el downstream filtra precioBase <= tope). Int ≥ 1.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  precioMaxCents?: number;

  // Ventana horaria de salida dentro del día pedido, hora-de-pared Lima HH:mm (hasta INCLUSIVE al minuto).
  @IsOptional()
  @Matches(LIMA_WALL_TIME_REGEX, {
    message: 'salidaDesde debe ser una hora-de-pared HH:mm (24h, sin segundos ni offset)',
  })
  salidaDesde?: string;

  @IsOptional()
  @Matches(LIMA_WALL_TIME_REGEX, {
    message: 'salidaHasta debe ser una hora-de-pared HH:mm (24h, sin segundos ni offset)',
  })
  salidaHasta?: string;

  /** Cursor keyset OPACO de la página previa (su forma interna la valida el downstream; es sort-aware). */
  @IsOptional()
  @IsString()
  cursor?: string;
}

/** Ids de región válidos del catálogo compartido (@veo/utils) — misma fuente que el downstream, cero listas paralelas. */
const REGION_IDS = REGIONS_PE.map((r) => r.id);

/**
 * BROWSE del marketplace (GET /carpool/trips/browse · espejo de BrowsePublishedTripsDto del downstream): el
 * FEED de todos los viajes publicados futuros — sin ruta ni fecha, TODOS los params opcionales. Filtro por
 * REGIÓN del catálogo compartido. SIN ventana horaria en v1 (decisión del downstream, documentada allá):
 * la franja fina se resuelve pasando al search del día elegido.
 */
export class BrowseCarpoolTripsDto {
  // Región del feed (id kebab-case del catálogo). Opcional: sin ella el feed es nacional. Filtra por el
  // ORIGEN del viaje; independiente de `destRegion` (puede venir solo uno, el otro, o ambos).
  @IsOptional()
  @IsIn(REGION_IDS, {
    message: `region debe ser una del catálogo: ${REGION_IDS.join(', ')}`,
  })
  region?: string;

  // Región DESTINO (mismo catálogo). Opcional e independiente de `region`: filtra por el DESTINO del viaje.
  @IsOptional()
  @IsIn(REGION_IDS, {
    message: `destRegion debe ser una del catálogo: ${REGION_IDS.join(', ')}`,
  })
  destRegion?: string;

  // Orden de la página: `salida` (default) o `precio` (más barato primero).
  @IsOptional()
  @IsIn(SEARCH_ORDER_VALUES)
  orden?: SearchOrder;

  // Precio máximo por asiento en céntimos PEN (el downstream filtra precioBase <= tope). Int ≥ 1.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  precioMaxCents?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  /** Cursor keyset OPACO de la página previa (mismo codec sort-aware del search; lo valida el downstream). */
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class CreateCarpoolBookingDto {
  @IsUUID()
  publishedTripId!: string;

  @IsInt()
  @Min(1)
  @Max(8)
  asientos!: number;

  // Método de pago elegido al reservar (el CHARGE al aprobar lo usa) — enum compartido, cero strings mágicos.
  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @IsLatitude()
  pickupLat!: number;

  @IsLongitude()
  pickupLon!: number;

  @IsLatitude()
  dropoffLat!: number;

  @IsLongitude()
  dropoffLon!: number;

  // Mensaje de presentación al conductor (modo REVISION).
  @IsOptional()
  @IsString()
  @MaxLength(500)
  mensajeIntro?: string;

  // Top-up en céntimos PEN sobre la base (mismo tope de dominio que el downstream: S/100.000).
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_00)
  specialRequest?: number;
}
