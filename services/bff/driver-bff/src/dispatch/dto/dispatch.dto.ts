import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsLatitude, IsLongitude, IsPositive } from 'class-validator';
import type { VehicleClass } from '@veo/shared-types';

export class SurgeQueryDto {
  @ApiProperty({ example: -12.0464 })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -77.0428 })
  @Type(() => Number)
  @IsLongitude()
  lon!: number;
}

/** Vista de una oferta/match de dispatch para el conductor. */
export interface OfferView {
  id: string;
  tripId: string;
  driverId: string;
  score: number;
  attempt: number;
  surgeMultiplier: number;
  outcome: string;
  offeredAt: string | null;
  respondedAt: string | null;
}

/** Vista del surge para un origen. */
export interface SurgeView {
  multiplier: number;
  zoneId: string | null;
  active: boolean;
}

/**
 * Cuerpo del submit de una oferta del conductor sobre una puja (ADR 010 §6). El driverId NO viaja en
 * el body: lo DERIVA el driver-bff de la identidad autenticada (anti-IDOR / cierre #9). El gate de
 * elegibilidad (online + biométrico + !suspendido + vehículo) se enforce downstream en dispatch.
 */
export class SubmitOfferDto {
  @ApiProperty({ enum: ['ACCEPT_PRICE', 'COUNTER'] })
  @IsEnum(['ACCEPT_PRICE', 'COUNTER'] as const)
  kind!: 'ACCEPT_PRICE' | 'COUNTER';

  @ApiProperty({ example: 700, description: 'ACCEPT_PRICE == bid; COUNTER > bid (céntimos PEN).' })
  @IsInt()
  @IsPositive()
  priceCents!: number;
}

/** Vista de una puja OPEN cercana que el conductor elegible puede ofertar. */
export interface OpenBidView {
  tripId: string;
  bidCents: number;
  /** Clase canónica del catálogo (ADR 013); dispatch la tipa igual en su `OpenBidDto`. */
  vehicleType: VehicleClass;
  expiresAt: number;
  originLat: number;
  originLon: number;
  /** BE-2 · solicitudes especiales del pasajero (mascota/equipaje/silla); el conductor las ve. */
  specialRequests: string[];
}

/** Vista de la oferta que el conductor acaba de enviar. */
export interface SubmittedOfferView {
  tripId: string;
  driverId: string;
  kind: string;
  priceCents: number;
  etaSeconds: number;
  status: string;
}
