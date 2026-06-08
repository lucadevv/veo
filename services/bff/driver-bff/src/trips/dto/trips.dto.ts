import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

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
  @ApiPropertyOptional({ description: 'Código modo niño (BR-T07), requerido si el viaje es childMode' })
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

/** Vista de un viaje (lado conductor). */
export interface TripView {
  id: string;
  passengerId: string;
  driverId: string | null;
  vehicleId: string | null;
  status: string;
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
  status: string;
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
}
