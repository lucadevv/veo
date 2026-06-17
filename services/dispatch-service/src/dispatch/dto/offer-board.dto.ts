import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, IsPositive, IsString, Max } from 'class-validator';
import { BID_MAX_CENTS } from '@veo/utils';
import { VehicleClass } from '@veo/shared-types';
import { OfferKind, OfferStatus, ClientBoardStatus } from '../offer-board.port';

/**
 * Cuerpo del submit de una oferta del conductor sobre una puja OPEN.
 *
 * NO lleva `driverId`: el conductor se DERIVA server-side de la identidad interna FIRMADA
 * (`@CurrentUser().driverId`, que el driver-bff firmó vía GetDriverByUser). Aceptar un driverId
 * del cliente acá permitiría ofertar SUPLANTANDO a cualquier conductor (cierre #9 en el trust
 * boundary). El controller IGNORA cualquier driverId que llegue en el body.
 */
export class SubmitOfferDto {
  @ApiProperty({ enum: OfferKind })
  @IsEnum(OfferKind)
  kind!: OfferKind;

  @ApiProperty({ example: 700, description: 'ACCEPT_PRICE == bid; COUNTER > bid (céntimos PEN).' })
  @IsInt()
  @IsPositive()
  // Techo de la contraoferta (ADR 010): un COUNTER pasa a ser el fareCents si el pasajero lo acepta,
  // así que no puede superar el BID_MAX_CENTS canónico (@veo/utils). El chequeo de dominio
  // AUTORITATIVO (contra el env BID_MAX_CENTS) vive en OfferBoardService.submitOffer; esta es la
  // barrera DTO (fail-fast en el borde).
  @Max(BID_MAX_CENTS)
  priceCents!: number;
}

/** Cuerpo de la aceptación de una oferta por el pasajero. */
export class AcceptOfferDto {
  @ApiProperty({ description: 'Conductor cuya oferta elige el pasajero.' })
  @IsString()
  driverId!: string;
}

/** Vista de una oferta del board (la respuesta de un conductor). */
export class OfferDto {
  @ApiProperty()
  tripId!: string;
  @ApiProperty()
  driverId!: string;
  @ApiProperty({ enum: OfferKind })
  kind!: OfferKind;
  @ApiProperty()
  priceCents!: number;
  @ApiProperty()
  etaSeconds!: number;
  @ApiProperty({ enum: OfferStatus })
  status!: OfferStatus;
}

/** Estado del board del lado del pasajero (suma 'GONE' = la key ya no existe en Redis, expiró por TTL). */
export class OffersBoardDto {
  @ApiProperty({ enum: ClientBoardStatus })
  status!: ClientBoardStatus;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'epoch(ms) de vencimiento de la ventana; null si el board no existe (GONE).',
  })
  expiresAt!: number | null;
}

/**
 * FIX contrato — respuesta de `GET /bids/:tripId/offers`: el ESTADO del board + las ofertas. Antes era solo
 * `OfferDto[]`; ahora el cliente distingue una puja OPEN-sin-ofertas de una CANCELLED/EXPIRED/GONE sin
 * adivinar por un array vacío. `offers` solo trae PENDING con board OPEN; en cualquier otro estado va [].
 */
export class OffersViewDto {
  @ApiProperty({ type: OffersBoardDto })
  board!: OffersBoardDto;

  @ApiProperty({ type: OfferDto, isArray: true })
  offers!: OfferDto[];
}

/** Vista de una puja OPEN cercana (lo que el conductor ve para ofertar). */
export class OpenBidDto {
  @ApiProperty()
  tripId!: string;
  @ApiProperty()
  bidCents!: number;
  @ApiProperty({ enum: VehicleClass })
  vehicleType!: VehicleClass;
  @ApiProperty({ description: 'epoch(ms) en que vence la ventana de la puja.' })
  expiresAt!: number;
  @ApiProperty({ example: -12.0464 })
  originLat!: number;
  @ApiProperty({ example: -77.0428 })
  originLon!: number;
  @ApiProperty({
    isArray: true,
    enum: ['PET', 'LUGGAGE', 'CHILD_SEAT'],
    description:
      'BE-2 · solicitudes especiales del pasajero; el conductor las ve antes de ofertar.',
  })
  specialRequests!: string[];
}
