/**
 * Ofertas de dispatch para el conductor.
 *  - Lecturas (GetMatch, GetSurge) por gRPC.
 *  - Comandos (accept/reject) por REST interno firmado.
 */
import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import { GrpcGateway } from '../infra/grpc.gateway';
import { RestGateway } from '../infra/rest.gateway';
import { PassengerVerificationService } from '../common/passenger-verification.service';
import type { DriverReply, MatchReply, SurgeReply, TripReply } from '../common/grpc-replies';
import type { OfferView, OpenBidView, SubmittedOfferView, SurgeView } from './dto/dispatch.dto';

function emptyToNull(value: string): string | null {
  return value ? value : null;
}

/**
 * Serializa la oferta ENRIQUECIDA: el match (id/score/…) + el resumen de DECISIÓN del viaje (tarifa,
 * distancia, duración, modo niño, origen/destino) + el badge de confianza. El viaje llega UNSCOPED
 * (la oferta ES la autorización). `originLng`/`destinationLng` del contrato gRPC se exponen como
 * `originLon`/`destLon` (convención de la app). Sin PII de identidad (regla #5): ni nombre ni childCode.
 */
export function toOfferView(
  match: MatchReply,
  trip: TripReply,
  passengerVerified: boolean,
): OfferView {
  return {
    id: match.id,
    tripId: match.tripId,
    driverId: match.driverId,
    score: match.score,
    attempt: match.attempt,
    surgeMultiplier: match.surgeMultiplier,
    outcome: match.outcome,
    offeredAt: emptyToNull(match.offeredAt),
    respondedAt: emptyToNull(match.respondedAt),
    originLat: trip.originLat,
    originLon: trip.originLng,
    destLat: trip.destinationLat,
    destLon: trip.destinationLng,
    fareCents: trip.fareCents,
    distanceMeters: trip.distanceMeters,
    durationSeconds: trip.durationSeconds,
    childMode: trip.childMode,
    specialRequests: trip.specialRequests,
    passengerVerified,
  };
}

export function toSurgeView(surge: SurgeReply): SurgeView {
  return {
    multiplier: surge.multiplier,
    zoneId: emptyToNull(surge.zoneId),
    active: surge.active,
  };
}

@Injectable()
export class DispatchService {
  constructor(
    private readonly grpc: GrpcGateway,
    private readonly rest: RestGateway,
    private readonly passengerVerification: PassengerVerificationService,
  ) {}

  async getOffer(matchId: string, identity: AuthenticatedUser): Promise<OfferView> {
    // El driverId se DERIVA de la identidad (GetDriverByUser) y se firma en la propagada: dispatch hace
    // el ownership-check con ESE driverId (anti-IDOR #9). El cliente nunca provee el driverId.
    const { identity: signed } = await this.resolveDriver(identity);
    const match = await this.grpc.call<MatchReply>('dispatch', 'GetMatch', { matchId }, signed);
    if (!match.found) throw new NotFoundError('Oferta no encontrada');
    // ENRIQUECIMIENTO · la oferta debe cargar el resumen de DECISIÓN del viaje para que la pantalla de
    // oferta entrante lo pinte SIN pegarle a `GET /trips/:id` (gateado por conductor asignado → el
    // ofertado aún no lo es → 404 "Viaje no encontrado", que rompía el match). Se lee el viaje UNSCOPED
    // (SIN el gate anti-IDOR de conductor-asignado): dispatch YA validó que ESTA oferta es de ESTE
    // conductor (GetMatch con el driverId derivado+firmado), así que la oferta ES la autorización para
    // ver el resumen. NO se debilita `GET /trips/:id`: solo la lectura de la oferta usa este camino.
    const trip = await this.grpc.call<TripReply>('trip', 'GetTrip', { id: match.tripId }, signed);
    if (!trip.found) throw new NotFoundError('Viaje de la oferta no encontrado');
    // ADR-018 §1(3) · badge de confianza (booleano PURO, cero PII). Resolución compartida (misma que
    // Lote 4): lazy al servir la oferta. Degrada a false si identity no responde (nunca rompe la oferta).
    const passengerVerified = await this.passengerVerification.resolve(trip.passengerId, signed);
    return toOfferView(match, trip, passengerVerified);
  }

  async accept(matchId: string, identity: AuthenticatedUser): Promise<unknown> {
    const { identity: signed } = await this.resolveDriver(identity);
    return this.dispatch().post(`/dispatch/offers/${matchId}/accept`, {
      identity: signed,
      body: {},
    });
  }

  async reject(matchId: string, identity: AuthenticatedUser): Promise<unknown> {
    const { identity: signed } = await this.resolveDriver(identity);
    return this.dispatch().post(`/dispatch/offers/${matchId}/reject`, {
      identity: signed,
      body: {},
    });
  }

  async getSurge(lat: number, lon: number, identity: AuthenticatedUser): Promise<SurgeView> {
    const surge = await this.grpc.call<SurgeReply>('dispatch', 'GetSurge', { lat, lon }, identity);
    return toSurgeView(surge);
  }

  // ── PUJA · lado conductor (ADR 010 §6) — driverId DERIVADO server-side, gate downstream ─────────

  /**
   * Lista las pujas OPEN cercanas que el conductor AUTENTICADO puede ofertar. El driverId se DERIVA
   * de la identidad (GetDriverByUser), nunca del cliente. dispatch re-valida la elegibilidad: si el
   * conductor no es elegible (offline/suspendido), responde 403, que se propaga limpio (cierre #9).
   */
  async listOpenBids(identity: AuthenticatedUser): Promise<OpenBidView[]> {
    const { identity: signed, driverId } = await this.resolveDriver(identity);
    return this.dispatch().get<OpenBidView[]>('/bids/open', {
      identity: signed,
      query: { driverId },
    });
  }

  /**
   * Envía una oferta/contraoferta a una puja. El driverId se DERIVA y se firma en la identidad +
   * viaja en el body para dispatch. El gate de elegibilidad (online + biométrico + !suspendido +
   * vehículo) se enforce en dispatch: una oferta no elegible → 403 propagado al conductor.
   */
  async submitOffer(
    tripId: string,
    kind: 'ACCEPT_PRICE' | 'COUNTER',
    priceCents: number,
    identity: AuthenticatedUser,
  ): Promise<SubmittedOfferView> {
    const { identity: signed, driverId } = await this.resolveDriver(identity);
    return this.dispatch().post<SubmittedOfferView>(`/bids/${tripId}/offers`, {
      identity: signed,
      body: { driverId, kind, priceCents },
    });
  }

  /**
   * Resuelve el driverId del usuario autenticado vía identity (GetDriverByUser) y lo adjunta a la
   * identidad propagada (firmada HMAC por los gateways). El cliente nunca provee el driverId: cierra
   * la clase IDOR (mismo patrón que earnings, Lote 0.2).
   */
  private async resolveDriver(
    identity: AuthenticatedUser,
  ): Promise<{ identity: AuthenticatedUser; driverId: string }> {
    const driver = await this.grpc.call<DriverReply>(
      'identity',
      'GetDriverByUser',
      { id: identity.userId },
      identity,
    );
    if (!driver.found)
      throw new NotFoundError('No existe un perfil de conductor para este usuario');
    return { identity: { ...identity, driverId: driver.id }, driverId: driver.id };
  }

  private dispatch() {
    return this.rest.client('dispatch');
  }
}
