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
import type { DriverReply, MatchReply, SurgeReply } from '../common/grpc-replies';
import type {
  OfferView,
  OpenBidView,
  SubmittedOfferView,
  SurgeView,
} from './dto/dispatch.dto';

function emptyToNull(value: string): string | null {
  return value ? value : null;
}

export function toOfferView(match: MatchReply): OfferView {
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
  ) {}

  async getOffer(matchId: string, identity: AuthenticatedUser): Promise<OfferView> {
    const match = await this.grpc.call<MatchReply>('dispatch', 'GetMatch', { matchId }, identity);
    if (!match.found) throw new NotFoundError('Oferta no encontrada');
    return toOfferView(match);
  }

  accept(matchId: string, identity: AuthenticatedUser): Promise<unknown> {
    return this.dispatch().post(`/dispatch/offers/${matchId}/accept`, { identity, body: {} });
  }

  reject(matchId: string, identity: AuthenticatedUser): Promise<unknown> {
    return this.dispatch().post(`/dispatch/offers/${matchId}/reject`, { identity, body: {} });
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
    if (!driver.found) throw new NotFoundError('No existe un perfil de conductor para este usuario');
    return { identity: { ...identity, driverId: driver.id }, driverId: driver.id };
  }

  private dispatch() {
    return this.rest.client('dispatch');
  }
}
