import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod, SpecialRequest, VehicleType } from '@veo/shared-types';
import { BID_MAX_CENTS } from '@veo/utils';

/** Máximo de paradas intermedias por viaje (Ola 2B, espeja trip-service). */
export const MAX_WAYPOINTS = 3;

export class GeoPointDto {
  @ApiProperty({ example: -12.0464 })
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -77.0428 })
  @IsLongitude()
  lon!: number;
}

/** Crear viaje (lado pasajero). El passengerId lo fija el BFF desde la identidad, no el cliente. */
export class CreateTripDto {
  @ApiProperty({ type: GeoPointDto })
  @ValidateNested()
  @Type(() => GeoPointDto)
  origin!: GeoPointDto;

  @ApiProperty({ type: GeoPointDto })
  @ValidateNested()
  @Type(() => GeoPointDto)
  destination!: GeoPointDto;

  @ApiPropertyOptional({
    type: [GeoPointDto],
    description:
      'Paradas intermedias ordenadas (Ola 2B, máx 3). La ruta y la tarifa firme las incluyen.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_WAYPOINTS)
  @ValidateNested({ each: true })
  @Type(() => GeoPointDto)
  waypoints?: GeoPointDto[];

  @ApiPropertyOptional({
    description:
      'Hora programada (Ola 2B, ISO-8601). Si se envía, el viaje nace programado (SCHEDULED) y el ' +
      'scheduler lo activa a la hora. Ventana válida [≥15min, ≤7días].',
    example: '2026-06-01T08:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  scheduledFor?: string;

  @ApiPropertyOptional({
    enum: VehicleType,
    description:
      'Tipo de vehículo (Ola 2B · moto-taxi). Suele derivarse de quoteOption.vehicleType.',
  })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;

  @ApiPropertyOptional({
    description:
      'PUJA (ADR 010): el bid del pasajero en céntimos PEN ("proponé tu precio"). Si se envía, el ' +
      'viaje arranca una puja (trip-service abre el board de negociación). Si se omite, se degrada al ' +
      'flujo de tarifa fija calculada por ruta (BR-T05) — compat con el camino previo.',
    example: 900,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  // Techo del bid (ADR 010): primera barrera en el borde. El BID_MAX_CENTS canónico (@veo/utils,
  // S/ 9,999) evita que un bid desbocado overflowee el int4 de Trip.fareCents aguas abajo. El chequeo
  // AUTORITATIVO vive server-side en trip-service (createTrip, contra su env BID_MAX_CENTS).
  @Max(BID_MAX_CENTS)
  bidCents?: number;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @ApiPropertyOptional({
    description:
      'Categoría/opción de tarifa elegida en la cotización (quoteOption.id, p.ej. veo_economico)',
    example: 'veo_economico',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  category?: string;

  @ApiPropertyOptional({ minimum: 1.0, maximum: 2.0, description: 'Surge (BR-T05)' })
  @IsOptional()
  @IsNumber()
  @Min(1.0)
  @Max(2.0)
  surgeMultiplier?: number;

  @ApiPropertyOptional({ description: 'Modo niño (BR-T07)' })
  @IsOptional()
  @IsBoolean()
  childMode?: boolean;

  @ApiPropertyOptional({ description: 'Código modo niño 4-6 dígitos (requerido si childMode)' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'El código de modo niño tiene 4 a 6 dígitos' })
  childCode?: string;

  @ApiPropertyOptional({
    description:
      'Código de promoción (Ola 2A). Se propaga al cobro; el descuento reduce solo lo que paga el pasajero.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  promoCode?: string;

  @ApiPropertyOptional({
    isArray: true,
    enum: SpecialRequest,
    description:
      'Solicitudes especiales (mascota/equipaje/silla); el conductor las ve antes de aceptar.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsEnum(SpecialRequest, { each: true })
  specialRequests?: SpecialRequest[];
}

/** Cancelar viaje. En el BFF de pasajero, el actor siempre es PASSENGER. */
export class CancelTripDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}

export class ChangeDestinationDto {
  @ApiProperty({ type: GeoPointDto })
  @ValidateNested()
  @Type(() => GeoPointDto)
  destination!: GeoPointDto;
}

/**
 * Lote C2 · POST /trips/:id/waypoints — el PASAJERO propone una parada DURANTE el viaje (IN_PROGRESS).
 * El cuerpo SOLO transporta el punto: el passengerId lo estampa el BFF desde la identidad (anti-IDOR) y
 * el delta de tarifa lo calcula trip-service (server-authoritative; el cliente no fija precio).
 */
export class ProposeWaypointDto {
  @ApiProperty({ type: GeoPointDto, description: 'Parada propuesta (lat/lon).' })
  @ValidateNested()
  @Type(() => GeoPointDto)
  point!: GeoPointDto;
}

/**
 * RE-PUJA del pasajero (ADR 010 #4/#12 · H6.4). El pasajero reactiva la puja de SU viaje
 * (REASSIGNING/EXPIRED) a un nuevo bid. El passengerId lo fija el BFF desde la identidad; el ownership
 * y la validación AUTORITATIVA (piso ≤ bid ≤ techo, estado válido) viven server-side en trip-service.
 */
export class RebidTripDto {
  @ApiProperty({
    description:
      'Nuevo bid en céntimos PEN ("subí tu precio"). Primera barrera en el borde; el gate AUTORITATIVO ' +
      '(piso de zona ≤ bid ≤ techo) vive en trip-service. @Max evita overflow del int4 aguas abajo.',
    example: 1200,
  })
  @IsInt()
  @Min(1)
  @Max(BID_MAX_CENTS)
  bidCents!: number;
}

/** Propina del pasajero a un viaje ya cobrado (BR-P04). 100% al conductor, fuera de comisión. */
export class AddTipDto {
  @ApiProperty({ description: 'Propina en céntimos PEN (entero positivo)' })
  @IsInt()
  @Min(1)
  tipCents!: number;
}

/**
 * Query del historial de viajes (GET /trips/history?cursor=&limit=). El passengerId NO va acá: lo fija
 * el BFF desde el JWT (anti-IDOR by construction). El cursor es opaco (token de la página previa); el
 * limit es opcional y el SERVIDOR lo acota a su tope (el cliente no puede forzar páginas enormes).
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
 * Query de la ruta del viaje (GET /trips/:id/route?leg=). Sin `leg` (default) se sirve la ruta CANÓNICA
 * persistida (origen→paradas→destino) — comportamiento previo intacto. `leg=pickup` pide el TRAMO DE
 * ACERCAMIENTO vivo (conductor→recojo) para el mapa del pasajero en las fases pre-recojo.
 */
export class TripRouteQueryDto {
  @ApiPropertyOptional({
    enum: ['pickup'],
    description:
      'Tramo pedido. `pickup` = conductor→recojo desde la última ubicación viva (fases pre-recojo); ' +
      'omitir = ruta canónica persistida del viaje.',
  })
  @IsOptional()
  @IsIn(['pickup'])
  leg?: 'pickup';
}

/** Recurso de viaje tal como lo devuelve trip-service en los comandos REST. */
export interface TripResource {
  id: string;
  passengerId: string;
  driverId: string | null;
  vehicleId: string | null;
  status: string;
  origin: { lat: number; lon: number };
  destination: { lat: number; lon: number };
  /** Paradas intermedias ordenadas (Ola 2B); [] si el viaje es directo. */
  waypoints: { lat: number; lon: number }[];
  fareCents: number;
  currency: string;
  surgeMultiplier: number;
  distanceMeters: number;
  durationSeconds: number;
  paymentMethod: string;
  routePolyline: string | null;
  /** Categoría/opción de tarifa elegida por el pasajero (quoteOption.id); null si no se envió. */
  category: string | null;
  /** Tipo de vehículo solicitado (Ola 2B · moto-taxi). */
  vehicleType: string;
  /** Hora programada (Ola 2B); null si es inmediato. */
  scheduledFor: string | null;
  childMode: boolean;
  penaltyCents: number;
  requestedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
}

/** Un paso de navegación turn-by-turn. Espeja `routeStep` de @veo/api-client (MISMO contrato que el
 *  driver-bff — la costura es simétrica entre ambas apps). */
export interface RouteStepView {
  instruction: string;
  distanceMeters: number;
  maneuver: string;
  geometryPolyline: string;
}

/** Ruta CANÓNICA del viaje para el mapa del pasajero: la persistida por trip-service
 *  (origen→paradas→destino; steps vacíos — la navegación es del conductor). Si el viaje no la tiene,
 *  fallback al cómputo por fase. Espeja `tripRoute` de @veo/api-client (mismo shape que el driver-bff). */
export interface TripRouteView {
  polyline: string;
  distanceMeters: number;
  durationSeconds: number;
  steps: RouteStepView[];
  /** Recojo, destino y paradas intermedias para los markers del mapa. */
  origin: { lat: number; lon: number };
  destination: { lat: number; lon: number };
  waypoints: { lat: number; lon: number }[];
}
