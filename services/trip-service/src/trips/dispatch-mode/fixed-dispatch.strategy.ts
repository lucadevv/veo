/**
 * FIXED (ADR 011) — precio fijo por ruta: emite trip.requested → dispatch corre el matching secuencial.
 * No hay negociación; la tarifa ya quedó calculada (calculateFare) al crear. emitTripRequested deriva
 * `scheduled` de trip.scheduledFor (una reserva activada lo trae seteado), así que ctx.scheduled no aplica.
 */
import type { LatLon } from '@veo/utils';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox } from '@veo/database';
import { PricingMode, TripStatus } from '@veo/shared-types';
import { emitTripRequested, recordTripEvent, PRODUCER } from '../trip-events';
import { calculateFirmFare } from '../domain/fare';
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
   * FIXED (BR-T05 + ADR 013 §1.7): IGNORA cualquier bid; calcula la tarifa FIRME por ruta
   * (distancia/duración/surge) le APLICA la política de la OFERTA y le suma el fee de niño PLANO:
   *
   *   fareCents = max(round(calculateFare(...) × pricing.multiplier), pricing.minFareCents) + FEE_NIÑO(plano)
   *
   * Cierra el bug del multiplier: antes veo_confort/veo_xl cobraban la tarifa de económico y veo_moto
   * cobraba MÁS que su preview. La fórmula vive en `calculateFirmFare` (domain/fare.ts, FUENTE ÚNICA —
   * también la consume el re-quote de la parada mid-trip): céntimos ENTEROS vía `scaleMoney` (Math.round),
   * y el FEE_NIÑO plano al final (ni el multiplier ni el surge lo escalan). Acá NO se redondea a S/0.10
   * como el preview del BFF (FARE_ROUNDING_CENTS): ese redondeo es cosmético del quote (que tampoco
   * incluye surge/niño); la tarifa firme es exacta al céntimo. No negocia → negotiationSeq=0.
   */
  resolveCreation(input: DispatchCreationInput): DispatchCreation {
    const fareCents = calculateFirmFare(
      {
        distanceMeters: input.route.distanceMeters,
        durationSeconds: input.route.durationSeconds,
        surgeMultiplier: input.surge,
        childMode: input.childMode,
        // F2.4 · tarifa base configurable (banderazo/km/min editables por el admin).
        baseFareCents: input.baseFareCents,
        perKmCents: input.perKmCents,
        perMinCents: input.perMinCents,
      },
      input.pricing,
    ).cents;
    return { fareCents, negotiationSeq: 0 };
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

  /**
   * FIXED · re-despacha tras el cancel del conductor: REASSIGNING + LIBERA al conductor cancelador +
   * re-emite trip.requested (mismo evento que la creación FIXED) para re-arrancar el matching secuencial.
   * La tarifa fija NO cambia (BR-T01 inmutable). NO toca negotiationSeq/agreedFareCents (dominio puja).
   *
   * La liberación va por `trip.reassigning` con `dispatchMode: 'FIXED'` — el MISMO evento que emite la
   * PUJA, porque sus consumidores son transversales al modo: identity lo consume para ON_TRIP→AVAILABLE
   * y dispatch para el hot-index release + conteo de la cancelación post-accept. Sin él (el seam roto
   * original) el conductor quedaba ON_TRIP para SIEMPRE tras cancelar un FIJO → "turno inactivo" en loop.
   * `dispatchMode: 'FIXED'` le dice a dispatch que NO re-abra el OfferBoard (el re-match acá es el
   * trip.requested secuencial; un board de puja fantasma sería doble oferta al conductor).
   */
  async reassign(
    tx: TxClient,
    trip: Trip,
    nextReassignCount: number,
    reason?: string,
  ): Promise<Trip> {
    const origin: LatLon = { lat: trip.originLat, lon: trip.originLon };
    const destination: LatLon = { lat: trip.destLat, lon: trip.destLon };
    const cancelledDriverId = trip.driverId;
    const next = await tx.trip.update({
      where: { id: trip.id },
      data: {
        status: TripStatus.REASSIGNING,
        driverId: null,
        reassignCount: nextReassignCount,
        cancellationReason: reason ?? 'driver_cancelled',
      },
    });
    await recordTripEvent(tx, trip.id, 'trip.reassigning', {
      from: trip.status,
      previousDriverId: cancelledDriverId,
      reassignCount: nextReassignCount,
      reason: 'driver_cancelled',
    });
    await enqueueOutbox(
      tx,
      createEnvelope({
        eventType: 'trip.reassigning',
        producer: PRODUCER,
        payload: {
          tripId: trip.id,
          // El conductor que canceló: identity lo devuelve a AVAILABLE y dispatch lo libera del hot-index.
          driverId: cancelledDriverId ?? '',
          passengerId: trip.passengerId,
          vehicleType: trip.vehicleType,
          category: trip.category ?? undefined,
          origin,
          destination,
          distanceMeters: trip.distanceMeters,
          durationSeconds: trip.durationSeconds,
          // FIXED no puja: la "oferta" es la tarifa firme (el schema exige bidCents; dispatch no lo usa
          // porque con dispatchMode FIXED no re-abre board).
          bidCents: trip.fareCents,
          reason: 'driver_cancelled',
          // FIXED no negocia (el row queda en 0); el schema exige un ciclo POSITIVO — valor de forma.
          negotiationSeq: trip.negotiationSeq + 1,
          dispatchMode: 'FIXED',
        },
      }),
      trip.id,
    );
    await emitTripRequested(tx, next, origin, destination);
    return next;
  }
}
