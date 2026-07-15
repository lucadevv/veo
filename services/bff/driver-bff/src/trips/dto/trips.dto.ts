import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import type { TripStatus } from '@veo/api-client';

export class AcceptTripDto {
  @ApiPropertyOptional({ description: 'ETA del conductor al recojo, en segundos' })
  @IsOptional()
  @IsInt()
  @Min(0)
  etaSeconds?: number;
}

export class ArrivingTripDto {
  @ApiPropertyOptional({ description: 'ETA restante al recojo, en segundos' })
  @IsOptional()
  @IsInt()
  @Min(0)
  etaSeconds?: number;
}

export class StartTripDto {
  @ApiPropertyOptional({
    description: 'Código modo niño (BR-T07), requerido si el viaje es childMode',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'El código de modo niño tiene 4 a 6 dígitos' })
  childCode?: string;
}

export class CancelTripDto {
  @ApiPropertyOptional({ description: 'Motivo de la cancelación' })
  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * Lote C2 · POST /trips/:id/waypoints/:proposalId/respond (lado conductor). El conductor ACEPTA o RECHAZA
 * la parada propuesta por el pasajero. El cuerpo SOLO transporta la decisión: el driverId NO se acepta del
 * cliente, el BFF lo DERIVA server-side (anti-IDOR) y lo manda al trip-service. Server-authoritative: el
 * conductor no fija la tarifa, solo acepta el delta ya estampado por trip-service al proponer.
 */
export class RespondWaypointDto {
  @ApiProperty({ description: 'true = aceptar la parada (se agrega al viaje); false = rechazar.' })
  @IsBoolean()
  accept!: boolean;
}

/**
 * POST /trips/:id/complete (lado conductor). EFECTIVO (decisión del dueño): al dar por terminado el
 * viaje, el conductor marca si COBRÓ el efectivo en mano (`cashCollected`) — su lado de la confirmación
 * bilateral (driverConfirmed, BR-P03). Solo aplica a viajes CASH; en digital se ignora. El driverId NO
 * se acepta del cliente: el BFF lo DERIVA server-side (anti-IDOR) y lo manda al trip-service.
 */
export class CompleteTripDto {
  @ApiPropertyOptional({
    description:
      'EFECTIVO · el conductor cobró el efectivo en mano al terminar (driverConfirmed). Solo aplica a ' +
      'viajes CASH; en digital se ignora. Omitido/false ⇒ flujo bilateral normal.',
  })
  @IsOptional()
  @IsBoolean()
  cashCollected?: boolean;
}

/**
 * POST /trips/:id/cash-confirm (lado conductor). EFECTIVO (decisión del dueño 2026-07-14): el conductor
 * confirma el cobro en mano DESPUÉS de completar el viaje, desde el resumen — confirmación ÚNICA que captura
 * directo (el conductor tiene la plata). `collected=true` ⇒ cobrado (captura); `collected=false` ⇒ reporta
 * que NO cobró (discrepancia). El driverId y el paymentId NO se aceptan del cliente: el BFF los DERIVA
 * server-side (anti-IDOR). Solo aplica a viajes CASH; si el pago no existe o no es CASH, el payment-service
 * responde el error y el BFF lo propaga.
 */
export class CashConfirmDto {
  @ApiProperty({
    description:
      'true = el conductor cobró el efectivo en mano (captura); false = reporta que NO cobró (discrepancia).',
  })
  @IsBoolean()
  collected!: boolean;
}

/**
 * Query opcional de GET /trips/:id/route: la POSICIÓN ACTUAL del conductor para calcular la ruta desde
 * donde está (ETA vivo + re-ruteo por desvío). Ambos opcionales y validados como lat/lon; el controller
 * exige AMBOS para usarlos (si falta uno, degrada a ruta desde el origen del viaje). `@Type(Number)`
 * porque el query string llega como texto y class-validator necesita el número para validar el rango.
 */
export class RouteQueryDto {
  @ApiPropertyOptional({ description: 'Latitud actual del conductor (-90..90)' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({ description: 'Longitud actual del conductor (-180..180)' })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lon?: number;
}

/**
 * Query del historial de viajes del conductor (GET /trips/history?cursor=&limit=). Espejo del
 * TripHistoryQueryDto del pasajero. El driverId NO va acá: lo DERIVA el BFF desde el JWT (anti-IDOR by
 * construction). El cursor es opaco (token de la página previa); el limit es opcional y el SERVIDOR lo
 * acota a su tope (el cliente no puede forzar páginas enormes).
 */
export class TripHistoryQueryDto {
  @ApiPropertyOptional({
    description: 'Cursor opaco de la página previa (nextCursor). Omitir = primera página.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Tamaño de página pedido; el servidor lo acota a su tope (≤50).',
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

/**
 * Un viaje en el historial del CONDUCTOR (card de "Mis Viajes"). Espejo del TripHistoryItemView del
 * pasajero: trae el ESTADO REAL del servidor (COMPLETED / CANCELLED / EXPIRED), que la lista local de la
 * app no tiene. Anti-N+1: sin lookups extra; el detalle (GET /trips/:id) resuelve lo que falte on-demand.
 */
export interface TripHistoryItemView {
  id: string;
  status: TripStatus;
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  fareCents: number;
  currency: string;
  paymentMethod: string;
  distanceMeters: number;
  durationSeconds: number;
  /** ISO-8601, siempre presente. */
  requestedAt: string;
  /** ISO-8601 o null si el viaje no llegó a COMPLETED. */
  completedAt: string | null;
  /** ISO-8601 o null si el viaje no fue cancelado. */
  cancelledAt: string | null;
  /** id de PERFIL del conductor (su propio id en el historial del conductor); null si nunca tuvo. */
  driverId: string | null;
  /** Tier (CAR|MOTO). */
  vehicleType: string;
  /** Categoría/opción elegida (quoteOption.id); null si no se eligió. */
  category: string | null;
}

/** Página del historial del conductor: items + cursor de la siguiente página (null si no hay más). */
export interface TripHistoryPageView {
  items: TripHistoryItemView[];
  nextCursor: string | null;
}

/** Vista de un viaje (lado conductor). */
export interface TripView {
  id: string;
  passengerId: string;
  driverId: string | null;
  vehicleId: string | null;
  status: TripStatus;
  fareCents: number;
  currency: string;
  distanceMeters: number;
  durationSeconds: number;
  paymentMethod: string;
  childMode: boolean;
  penaltyCents: number;
  /** Primer nombre del pasajero (PII mínima, Ley 29733) para el header del chat; `null` si no se resolvió. */
  passengerFirstName: string | null;
  /** Rating del pasajero (0–5), `null` si no tiene calificaciones (señal de confianza, agregado — no identifica). */
  passengerRating: number | null;
  /** Nº de calificaciones del pasajero (count30d de rating-service). */
  passengerRatingCount: number;
  /** Viajes COMPLETED de por vida del pasajero (señal de confianza, agregado — no identifica). */
  passengerTripCount: number;
}

/** Vista del estado del viaje (para tracking ligero). */
export interface TripStateView {
  id: string;
  status: TripStatus;
}

/** Un paso de navegación turn-by-turn (Ola 2C). Espeja `routeStep` de @veo/api-client. */
export interface RouteStepView {
  instruction: string;
  distanceMeters: number;
  maneuver: string;
  geometryPolyline: string;
}

/** Ruta del viaje activo CON pasos de navegación (Ola 2C). Espeja `tripRoute` de @veo/api-client. */
export interface TripRouteView {
  polyline: string;
  distanceMeters: number;
  durationSeconds: number;
  steps: RouteStepView[];
  /** Recojo, destino y paradas intermedias (Ola 2B) para los markers del mapa del conductor. */
  origin: { lat: number; lon: number };
  destination: { lat: number; lon: number };
  waypoints: { lat: number; lon: number }[];
}
