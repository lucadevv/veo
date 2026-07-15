/**
 * PUJA (ADR 010 §2) — abre la negociación: emite trip.bid_posted → dispatch abre el OfferBoard y hace
 * broadcast a conductores elegibles (ventana = bidWindowSec). El bid del pasajero YA es el fareCents.
 */
import { ValidationError, type LatLon } from '@veo/utils';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox } from '@veo/database';
import { PricingMode, TripStatus } from '@veo/shared-types';
import { emitBidPosted, recordTripEvent, PRODUCER } from '../trip-events';
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

  /**
   * PUJA · re-abre el OfferBoard tras el cancel del conductor. El bidCents es el del viaje (no sube solo;
   * la subida es el rebid explícito del pasajero). H12+H13 van en el MISMO update (atómico): reset del
   * guard once-ever de applyAgreedFare (agreedFareCents=null, si no el re-match cobraría el precio viejo) +
   * bump del sello de ciclo monotónico (negotiationSeq+1, bloquea un offer_accepted STALE del ciclo viejo).
   */
  async reassign(
    tx: TxClient,
    trip: Trip,
    nextReassignCount: number,
    reason?: string,
  ): Promise<Trip> {
    const bidCents = trip.fareCents;
    const cancelledDriverId = trip.driverId;
    const nextNegotiationSeq = trip.negotiationSeq + 1;

    const next = await tx.trip.update({
      where: { id: trip.id },
      data: {
        status: TripStatus.REASSIGNING,
        // El conductor que canceló se desvincula: el re-match elegirá a otro. Sin penalización al pasajero.
        driverId: null,
        // H12 — reset del guard once-ever para que el offer_accepted del re-match aplique el precio FRESCO.
        agreedFareCents: null,
        reassignCount: nextReassignCount,
        // H13 — bump del sello de ciclo en la MISMA tx que el reset del agreedFareCents (atómico).
        negotiationSeq: nextNegotiationSeq,
        cancellationReason: reason ?? 'driver_cancelled',
      },
    });
    await recordTripEvent(tx, trip.id, 'trip.reassigning', {
      from: trip.status,
      previousDriverId: cancelledDriverId,
      reassignCount: nextReassignCount,
      bidCents,
      negotiationSeq: nextNegotiationSeq,
      reason: 'driver_cancelled',
    });
    await enqueueOutbox(
      tx,
      createEnvelope({
        eventType: 'trip.reassigning',
        producer: PRODUCER,
        payload: {
          tripId: trip.id,
          // El conductor que canceló: dispatch lo LIBERA del hot-index (vuelve a ser elegible).
          driverId: cancelledDriverId ?? '',
          passengerId: trip.passengerId,
          vehicleType: trip.vehicleType,
          // B5-3: oferta del viaje — dispatch la re-persiste en el board re-abierto para enforcar el TIER
          // en el re-match igual que en la puja original (sin esto el board re-abierto perdería los requires).
          category: trip.category ?? undefined,
          origin: { lat: trip.originLat, lon: trip.originLon },
          // Destino + distancia/duración del viaje: el board re-abierto los conserva para que el conductor del
          // re-match VEA pickup→destino + distancia igual que en la puja original (cierra el gap que tenía
          // specialRequests, que se degradaba a [] al reconstruir el board desde el evento). Del row Trip.
          destination: { lat: trip.destLat, lon: trip.destLon },
          distanceMeters: trip.distanceMeters,
          durationSeconds: trip.durationSeconds,
          bidCents,
          reason: 'driver_cancelled',
          // H13 — dispatch persiste este seq en el board re-abierto y lo estampa en offer_accepted.
          negotiationSeq: nextNegotiationSeq,
          // PUJA explícito (= el default legacy): dispatch re-abre el OfferBoard con este evento.
          dispatchMode: 'PUJA',
        },
      }),
      trip.id,
    );
    return next;
  }
}
