/**
 * FIXED (ADR 011) — precio fijo por ruta: emite trip.requested → dispatch corre el matching secuencial.
 * No hay negociación; la tarifa ya quedó calculada (calculateFare) al crear. emitTripRequested deriva
 * `scheduled` de trip.scheduledFor (una reserva activada lo trae seteado), así que ctx.scheduled no aplica.
 */
import type { LatLon } from '@veo/utils';
import { PricingMode } from '@veo/shared-types';
import { emitTripRequested } from '../trip-events';
import { calculateFare } from '../domain/fare';
import type { Prisma, Trip } from '../../generated/prisma';
import type {
  DispatchModeStrategy,
  DispatchOpenContext,
  DispatchCreationInput,
  DispatchCreation,
} from './dispatch-mode.strategy';

type TxClient = Prisma.TransactionClient;

export class FixedDispatchStrategy implements DispatchModeStrategy {
  readonly mode = PricingMode.FIXED;

  /**
   * FIXED (BR-T05): IGNORA cualquier bid; calcula la tarifa FIRME por ruta (distancia/duración/surge/niño).
   * No negocia → negotiationSeq=0 (nunca emite offer_accepted).
   */
  resolveCreation(input: DispatchCreationInput): DispatchCreation {
    const fare = calculateFare({
      distanceMeters: input.route.distanceMeters,
      durationSeconds: input.route.durationSeconds,
      surgeMultiplier: input.surge,
      childMode: input.childMode,
    });
    return { fareCents: fare.cents, negotiationSeq: 0 };
  }

  async openDispatch(
    tx: TxClient,
    trip: Trip,
    origin: LatLon,
    destination: LatLon,
    _ctx: DispatchOpenContext,
  ): Promise<void> {
    await emitTripRequested(tx, trip, origin, destination);
  }
}
