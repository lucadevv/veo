/**
 * PUJA (ADR 010 §2) — abre la negociación: emite trip.bid_posted → dispatch abre el OfferBoard y hace
 * broadcast a conductores elegibles (ventana = bidWindowSec). El bid del pasajero YA es el fareCents.
 */
import type { LatLon } from '@veo/utils';
import { PricingMode } from '@veo/shared-types';
import { emitBidPosted } from '../trip-events';
import type { Prisma, Trip } from '../../generated/prisma';
import type { DispatchModeStrategy, DispatchOpenContext } from './dispatch-mode.strategy';

type TxClient = Prisma.TransactionClient;

export class PujaDispatchStrategy implements DispatchModeStrategy {
  readonly mode = PricingMode.PUJA;

  constructor(private readonly bidWindowSec: number) {}

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
