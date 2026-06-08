/**
 * PUJA (ADR 010 §2) — abre la negociación: emite trip.bid_posted → dispatch abre el OfferBoard y hace
 * broadcast a conductores elegibles (ventana = bidWindowSec). El bid del pasajero YA es el fareCents.
 */
import { ValidationError, type LatLon } from '@veo/utils';
import { PricingMode } from '@veo/shared-types';
import { emitBidPosted } from '../trip-events';
import type { Prisma, Trip } from '../../generated/prisma';
import type {
  DispatchModeStrategy,
  DispatchOpenContext,
  DispatchCreationInput,
  DispatchCreation,
} from './dispatch-mode.strategy';

type TxClient = Prisma.TransactionClient;

export class PujaDispatchStrategy implements DispatchModeStrategy {
  readonly mode = PricingMode.PUJA;

  constructor(
    private readonly bidWindowSec: number,
    private readonly bidMaxCents: number,
  ) {}

  /**
   * PUJA (ADR 010 §2/§9.3): REQUIERE el bid (validado piso ≤ bid ≤ techo). El bid ES el fareCents (el
   * surge solo SUGIERE, no se aplica). El techo es el gate AUTORITATIVO anti-overflow del int4 de fareCents.
   */
  resolveCreation(input: DispatchCreationInput): DispatchCreation {
    if (input.bidCents === undefined) {
      throw new ValidationError('falta tu oferta', { mode: this.mode });
    }
    if (input.bidCents < input.floorCents) {
      throw new ValidationError(
        `El bid (${input.bidCents}) es menor al piso de la zona (${input.floorCents}) (ADR 010 §9.3)`,
        { bidCents: input.bidCents, floorCents: input.floorCents },
      );
    }
    if (input.bidCents > this.bidMaxCents) {
      throw new ValidationError(
        `El bid (${input.bidCents}) supera el techo permitido (${this.bidMaxCents}) (ADR 010)`,
        { bidCents: input.bidCents, maxCents: this.bidMaxCents },
      );
    }
    // H13 — el bid abre el PRIMER ciclo de negociación (seq=1).
    return { fareCents: input.bidCents, negotiationSeq: 1 };
  }

  async openDispatch(
    tx: TxClient,
    trip: Trip,
    origin: LatLon,
    _destination: LatLon,
    ctx: DispatchOpenContext,
  ): Promise<void> {
    // ctx.scheduled=true (activación de reserva): el pasajero no está en la app; notification-service le
    // manda el push con deep-link al board.
    await emitBidPosted(tx, trip, origin, this.bidWindowSec, ctx.scheduled);
  }
}
