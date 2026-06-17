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
