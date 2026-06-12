/**
 * API REST de la PUJA (OfferBoard, ADR 010 §1, §5, §6). Protegida con InternalIdentityGuard:
 * la llaman los BFFs con la identidad firmada del usuario final, que ya hizo el gate de ROL+OWNERSHIP.
 *
 *  Lado PASAJERO (public-bff, tras ownership-check del tripId):
 *   - GET  /bids/:tripId/offers        → lista las ofertas del board.
 *   - POST /bids/:tripId/accept        → el pasajero elige UNA oferta (idempotente).
 *   - POST /bids/:tripId/cancel        → el pasajero cancela la puja.
 *
 *  Lado CONDUCTOR (driver-bff; el driverId se DERIVA de la identidad FIRMADA, NUNCA del cliente):
 *   - GET  /bids/open                  → pujas OPEN cercanas que el conductor elegible puede ofertar.
 *   - POST /bids/:tripId/offers        → submit oferta/contraoferta (gate de elegibilidad downstream).
 *
 * dispatch NO confía en el rol del cliente: el gate de elegibilidad del conductor se RE-VALIDA en el
 * service (cierre estructural del #9). El ownership del pasajero lo enforce el public-bff antes de llamar.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, InternalIdentityGuard, type AuthenticatedUser } from '@veo/auth';
import { OfferBoardService } from './offer-board.service';
import { requireDriverId } from './require-driver-id';
import { bidFieldsFromBoard, type Offer, type OfferBoard, type OffersView } from './offer-board.port';
import {
  AcceptOfferDto,
  OfferDto,
  OffersViewDto,
  OpenBidDto,
  SubmitOfferDto,
} from './dto/offer-board.dto';

function toOfferDto(o: Offer): OfferDto {
  return {
    tripId: o.tripId,
    driverId: o.driverId,
    kind: o.kind,
    priceCents: o.priceCents,
    etaSeconds: o.etaSeconds,
    status: o.status,
  };
}

function toOpenBidDto(b: OfferBoard): OpenBidDto {
  // MISMO derivador que el enrich del broadcast (`bidFieldsFromBoard`) → el REST y el ping `dispatch.offered`
  // no pueden divergir. `expiresAt` (epoch ms) es propio del REST; el ping lo lleva como ISO aparte.
  return { tripId: b.tripId, expiresAt: b.expiresAt, ...bidFieldsFromBoard(b) };
}

@ApiTags('bids')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('bids')
export class OfferBoardController {
  constructor(private readonly board: OfferBoardService) {}

  // ── Lado conductor ──────────────────────────────────────────────────────────────────────────

  @Get('open')
  @ApiOperation({ summary: 'Pujas OPEN cercanas que el conductor ELEGIBLE puede ofertar' })
  async listOpen(@CurrentUser() user: AuthenticatedUser): Promise<OpenBidDto[]> {
    // El driverId sale de la identidad FIRMADA, NUNCA de un query param del cliente (anti-IDOR #9).
    const driverId = requireDriverId(user);
    const boards = await this.board.listOpenBidsNear(driverId);
    return boards.map(toOpenBidDto);
  }

  @Post(':tripId/offers')
  @HttpCode(201)
  @ApiOperation({ summary: 'El conductor oferta/contraoferta (gate de elegibilidad re-validado)' })
  async submitOffer(
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SubmitOfferDto,
  ): Promise<OfferDto> {
    // El driverId sale de la identidad FIRMADA: un cliente no puede ofertar suplantando a otro conductor.
    const driverId = requireDriverId(user);
    const offer = await this.board.submitOffer({
      driverId,
      tripId,
      kind: dto.kind,
      priceCents: dto.priceCents,
    });
    return toOfferDto(offer);
  }

  // ── Lado pasajero ───────────────────────────────────────────────────────────────────────────

  @Get(':tripId/offers')
  @ApiOperation({ summary: 'Estado del board + ofertas del board (el pasajero las ve para elegir)' })
  async listOffers(@Param('tripId', ParseUUIDPipe) tripId: string): Promise<OffersViewDto> {
    const view: OffersView = await this.board.getOffersView(tripId);
    return {
      board: { status: view.board.status, expiresAt: view.board.expiresAt },
      offers: view.offers.map(toOfferDto),
    };
  }

  @Post(':tripId/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'El pasajero elige UNA oferta → match (idempotente)' })
  async accept(
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: AcceptOfferDto,
  ): Promise<OfferDto> {
    const offer = await this.board.acceptOffer(tripId, dto.driverId);
    return toOfferDto(offer);
  }

  @Post(':tripId/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'El pasajero cancela la puja → board CANCELLED + cierra el VIAJE (idempotente)' })
  async cancel(@Param('tripId', ParseUUIDPipe) tripId: string): Promise<{ ok: true }> {
    // emitClosure: este es el cancel de la PUJA del pasajero → además de cerrar el board efímero, emite
    // dispatch.bid_cancelled por outbox para que trip cierre el VIAJE (REQUESTED → CANCELLED_BY_PASSENGER),
    // no solo el board. El ownership ya lo gateó el public-bff (assertOwnsTrip) antes de llamar acá.
    await this.board.cancelBoard(tripId, { emitClosure: true });
    return { ok: true };
  }
}
