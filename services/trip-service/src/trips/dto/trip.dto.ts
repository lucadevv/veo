import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod, PricingMode, SpecialRequest, TripStatus, VehicleType } from '@veo/shared-types';
import { BID_MAX_CENTS } from '@veo/utils';

/** Máximo de paradas intermedias por viaje (Ola 2B · waypoints). */
export const MAX_WAYPOINTS = 3;

export class GeoPointDto {
  @ApiProperty({ example: -12.0464 })
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -77.0428 })
  @IsLongitude()
  lon!: number;
}

export class CreateTripDto {
  @ApiProperty({ format: 'uuid', description: 'Pasajero (identity-service)' })
  @IsUUID()
  passengerId!: string;

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
      'Paradas intermedias ORDENADAS entre origen y destino (Ola 2B, máx 3). La ruta y la tarifa ' +
      'firme (BR-T05) consideran el recorrido multi-punto. Omitir = viaje directo.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_WAYPOINTS)
  @ValidateNested({ each: true })
  @Type(() => GeoPointDto)
  waypoints?: GeoPointDto[];

  @ApiPropertyOptional({
    description:
      'Hora programada del viaje (Ola 2B, ISO-8601). Si se envía, el viaje nace SCHEDULED y el ' +
      'scheduler lo activa a la hora (menos el lead time). Debe estar en una ventana [≥15min, ≤7días].',
    example: '2026-06-01T08:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  scheduledFor?: string;

  @ApiPropertyOptional({
    enum: VehicleType,
    description:
      'Tipo de vehículo solicitado (Ola 2B · tier moto-taxi). MOTO ⇒ el viaje solo se ofrece a ' +
      'conductores con vehículo MOTO. Default CAR. Normalmente se deriva de la categoría elegida.',
  })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;

  @ApiPropertyOptional({
    description:
      'PUJA (ADR 010): el bid del pasajero en céntimos PEN ("proponé tu precio"). Pasa a ser el ' +
      'fareCents del viaje, validado ≥ piso (Admin·Pricing por zona; hoy piso global temporal). ' +
      'Si se omite, se degrada a la tarifa calculada por ruta (BR-T05) — compat con el flujo previo.',
    example: 900,
  })
  @IsOptional()
  @IsNumber()
  @IsInt()
  @Min(1)
  // Techo del bid (ADR 010): el BID_MAX_CENTS canónico (@veo/utils, S/ 9,999) impide que un bid
  // desbocado overflowee el int4 de Trip.fareCents. El chequeo de dominio AUTORITATIVO (contra el env
  // BID_MAX_CENTS, ajustable por entorno) vive en TripsService.createTrip; este @Max es la barrera DTO.
  @Max(BID_MAX_CENTS)
  bidCents?: number;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @ApiPropertyOptional({
    description:
      'Categoría/opción de tarifa elegida en la cotización (quoteOption.id, p.ej. veo_economico). ' +
      'Se persiste tal cual; el multiplicador por categoría lo aplica la previsualización del BFF, ' +
      'no se recalcula la tarifa firme aquí (BR-T05).',
    example: 'veo_economico',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  category?: string;

  @ApiPropertyOptional({ minimum: 1.0, maximum: 2.0, default: 1.0, description: 'Surge (BR-T05)' })
  @IsOptional()
  @IsNumber()
  @Min(1.0)
  @Max(2.0)
  surgeMultiplier?: number;

  @ApiPropertyOptional({ default: false, description: 'Modo niño (BR-T07)' })
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
      'Código de promoción (Ola 2A). Se persiste y se propaga en trip.completed para que ' +
      'payment-service lo canjee al cobrar (descuento solo al pasajero).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  promoCode?: string;

  @ApiPropertyOptional({
    isArray: true,
    enum: SpecialRequest,
    description:
      'Solicitudes especiales para el conductor (mascota/equipaje/silla de niño). Las ve ANTES de ' +
      'aceptar. "Parada" no va acá: es un waypoint. Vacío/omitido = ninguna.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsEnum(SpecialRequest, { each: true })
  specialRequests?: SpecialRequest[];
}

export class AssignTripDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  driverId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  vehicleId!: string;
}

export class AcceptTripDto {
  @ApiPropertyOptional({ description: 'ETA del conductor al recojo, en segundos' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  etaSeconds?: number;

  /**
   * A1 · ownership server-side (anti-IDOR). El driver-bff lo DERIVA del perfil del conductor
   * (GetDriverByUser → driver.id) y lo envía; trip-service verifica `trip.driverId === driverId`
   * (404 si no coincide). El cliente final NUNCA lo provee. Opcional para no romper callers legacy.
   */
  @ApiPropertyOptional({ description: 'driverId derivado server-side por el BFF (anti-IDOR); el cliente no lo envía' })
  @IsOptional()
  @IsString()
  driverId?: string;
}

export class ArrivingTripDto {
  @ApiPropertyOptional({ description: 'ETA restante al recojo, en segundos' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  etaSeconds?: number;

  /** A1 · ownership server-side (anti-IDOR). driverId derivado por el BFF; trip-service verifica trip.driverId === driverId (404). */
  @ApiPropertyOptional({ description: 'driverId derivado server-side por el BFF (anti-IDOR); el cliente no lo envía' })
  @IsOptional()
  @IsString()
  driverId?: string;
}

/** POST /trips/:id/arrived — el cuerpo solo transporta el driverId derivado por el BFF (anti-IDOR). */
export class ArrivedTripDto {
  /** A1 · ownership server-side (anti-IDOR). driverId derivado por el BFF; trip-service verifica trip.driverId === driverId (404). */
  @ApiPropertyOptional({ description: 'driverId derivado server-side por el BFF (anti-IDOR); el cliente no lo envía' })
  @IsOptional()
  @IsString()
  driverId?: string;
}

export class StartTripDto {
  @ApiPropertyOptional({ description: 'Código modo niño (BR-T07), requerido si el viaje es childMode' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'El código de modo niño tiene 4 a 6 dígitos' })
  childCode?: string;

  /**
   * A1 · ownership server-side (anti-IDOR). El driver-bff lo DERIVA del perfil del conductor
   * (GetDriverByUser → driver.id) desde la identidad autenticada y lo envía; trip-service verifica
   * `trip.driverId === driverId` (404 si no coincide, no filtra existencia ajena). El cliente final
   * NUNCA lo provee. Opcional en el contrato para no romper callers legacy que aún no lo envían.
   */
  @ApiPropertyOptional({ description: 'driverId derivado server-side por el BFF (anti-IDOR); el cliente no lo envía' })
  @IsOptional()
  @IsString()
  driverId?: string;
}

/**
 * POST /trips/:id/complete — finaliza el viaje. EFECTIVO (decisión del dueño): el conductor, al dar
 * por terminado, marca si COBRÓ el efectivo en mano (`cashCollected`). Solo significativo si el viaje
 * es CASH: viaja en trip.completed para que payment-service cree la CashConfirmation con
 * driverConfirmed=true (solo falta el pasajero). En métodos digitales el flag se ignora (no rompe el
 * complete actual). El driverId lo DERIVA el driver-bff server-side (anti-IDOR), el cliente no lo envía.
 */
export class CompleteTripDto {
  @ApiPropertyOptional({
    description:
      'EFECTIVO · el conductor cobró en mano al terminar (driverConfirmed). Solo aplica a viajes CASH; ' +
      'en digital se ignora. Omitido/false ⇒ flujo bilateral normal (el conductor confirma por separado).',
  })
  @IsOptional()
  @IsBoolean()
  cashCollected?: boolean;

  /**
   * A1 · ownership server-side (anti-IDOR). El driver-bff lo DERIVA del perfil del conductor
   * (GetDriverByUser → driver.id) y lo envía; trip-service verifica `trip.driverId === driverId`
   * (404 si no coincide). El cliente final NUNCA lo provee. Opcional para no romper callers legacy.
   */
  @ApiPropertyOptional({ description: 'driverId derivado server-side por el BFF (anti-IDOR); el cliente no lo envía' })
  @IsOptional()
  @IsString()
  driverId?: string;
}

export class CancelTripDto {
  @ApiProperty({ enum: ['PASSENGER', 'DRIVER'] })
  @IsEnum({ PASSENGER: 'PASSENGER', DRIVER: 'DRIVER' })
  by!: 'PASSENGER' | 'DRIVER';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;

  /**
   * A1 · ownership server-side (anti-IDOR). El BFF lo fija desde la identidad autenticada cuando
   * `by==='PASSENGER'`; trip-service verifica `trip.passengerId === passengerId` (404 si no, no filtra
   * existencia ajena). Opcional en el contrato porque la cancelación por el CONDUCTOR no lo envía.
   */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  passengerId?: string;
}

export class ChangeDestinationDto {
  @ApiProperty({ type: GeoPointDto })
  @ValidateNested()
  @Type(() => GeoPointDto)
  destination!: GeoPointDto;

  /** A1 · ownership server-side (anti-IDOR). El BFF lo fija desde la identidad autenticada del pasajero. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  passengerId?: string;
}

/**
 * POST /trips/:id/rebid — RE-PUJA del pasajero (ADR 010 #4/#12 · H6.4). Reactiva la puja de un viaje
 * que quedó en REASSIGNING (re-match en curso) o EXPIRED (sin ofertas) a un NUEVO bid. El passengerId
 * lo fija el BFF desde la identidad autenticada (trip-service verifica la pertenencia server-side).
 */
export class RebidTripDto {
  @ApiProperty({ format: 'uuid', description: 'Pasajero dueño del viaje (ownership server-side)' })
  @IsUUID()
  passengerId!: string;

  @ApiProperty({
    description:
      'Nuevo bid en céntimos PEN. El gate AUTORITATIVO (piso de zona ≤ bid ≤ techo) vive en ' +
      'TripsService.rebid; este @Max es la barrera DTO (anti-overflow int4, espeja createTrip).',
    example: 1200,
  })
  @IsInt()
  @Min(1)
  @Max(BID_MAX_CENTS)
  bidCents!: number;
}

/** GET /trips/scheduled?passengerId= — el BFF fija el passengerId desde la identidad autenticada. */
export class ScheduledListQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  passengerId!: string;
}

/** DELETE /trips/:id/schedule — el BFF fija el passengerId desde la identidad autenticada. */
export class CancelScheduledDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  passengerId!: string;
}

/** Vista pública de un viaje (respuesta REST/gRPC). */
export interface TripView {
  id: string;
  passengerId: string;
  driverId: string | null;
  vehicleId: string | null;
  status: TripStatus;
  origin: { lat: number; lon: number };
  destination: { lat: number; lon: number };
  /** Paradas intermedias ordenadas (Ola 2B); [] si el viaje es directo. */
  waypoints: { lat: number; lon: number }[];
  fareCents: number;
  currency: string;
  surgeMultiplier: number;
  distanceMeters: number;
  durationSeconds: number;
  paymentMethod: PaymentMethod;
  routePolyline: string | null;
  /** Categoría/opción de tarifa elegida por el pasajero (quoteOption.id); null si no se envió. */
  category: string | null;
  /** Tipo de vehículo solicitado (Ola 2B · moto-taxi). */
  vehicleType: VehicleType;
  /**
   * S1 (ADR 011) — modo de despacho AUTORITATIVO CONGELADO del viaje (PUJA | FIXED), resuelto por el
   * servidor al crear (resolve-once §1.2). Es el modo REAL del viaje, no el que mostró el quote: si el
   * schedule flipeó entre el quote y createTrip, la app reconcilia con ESTE valor (refresca/avisa) en vez
   * de mostrar un modo y obtener otro (p.ej. mandar un bid que FIXED silenciosamente ignoraría).
   */
  dispatchMode: PricingMode;
  /** Hora programada (Ola 2B); null si es inmediato. */
  scheduledFor: string | null;
  childMode: boolean;
  /** Solicitudes especiales del pasajero (BE-2); vacío = ninguna. */
  specialRequests: SpecialRequest[];
  penaltyCents: number;
  requestedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  /**
   * Re-entrada del cierre post-viaje: ISO-8601 de cuándo el PASAJERO dio por cerrado el post-viaje
   * (recibo/efectivo/rating); null = aún sin cerrar (pending settlement). COMPLETED sigue terminal.
   */
  passengerClosedAt: string | null;
}
