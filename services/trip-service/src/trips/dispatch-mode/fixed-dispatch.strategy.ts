/**
 * FIXED (ADR 011) — precio fijo por ruta: emite trip.requested → dispatch corre el matching secuencial.
 * No hay negociación; la tarifa ya quedó calculada (calculateFare) al crear. emitTripRequested deriva
 * `scheduled` de trip.scheduledFor (una reserva activada lo trae seteado), así que ctx.scheduled no aplica.
 */
import type { LatLon } from '@veo/utils';
import { PricingMode, TripStatus } from '@veo/shared-types';
import { emitTripRequested } from '../trip-events';
import { applyOfferingPricing, calculateFare } from '../domain/fare';
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
   * (distancia/duración/surge/niño) y le APLICA la política de la OFERTA:
   *
   *   fareCents = max(round(calculateFare(...) × pricing.multiplier), pricing.minFareCents)
   *
   * Cierra el bug del multiplier: antes veo_confort/veo_xl cobraban la tarifa de económico y veo_moto
   * cobraba MÁS que su preview. La fórmula vive en `applyOfferingPricing` (domain/fare.ts, FUENTE
   * ÚNICA — también la consume el re-quote de la parada mid-trip): céntimos ENTEROS vía `scaleMoney`
   * (Math.round), la MISMA convención de calculateFare (que ya usa scaleMoney para el surge). Acá NO
   * se redondea a S/0.10 como el preview del BFF (FARE_ROUNDING_CENTS): ese redondeo es cosmético del
   * quote (que tampoco incluye surge/niño); la tarifa firme es exacta al céntimo. No negocia →
   * negotiationSeq=0 (nunca emite offer_accepted).
   */
  resolveCreation(input: DispatchCreationInput): DispatchCreation {
    const base = calculateFare({
      distanceMeters: input.route.distanceMeters,
      durationSeconds: input.route.durationSeconds,
      surgeMultiplier: input.surge,
      childMode: input.childMode,
      // F2.4 · tarifa base configurable (banderazo/km/min editables por el admin).
      baseFareCents: input.baseFareCents,
      perKmCents: input.perKmCents,
      perMinCents: input.perMinCents,
    });
    return { fareCents: applyOfferingPricing(base, input.pricing).cents, negotiationSeq: 0 };
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
   * FIXED · re-despacha tras el cancel del conductor: REASSIGNING + libera al conductor + re-emite
   * trip.requested (mismo evento que la creación FIXED) para re-arrancar el matching secuencial. La tarifa
   * fija NO cambia (BR-T01 inmutable). NO toca negotiationSeq/agreedFareCents (dominio puja, irrelevantes).
   */
  async reassign(
    tx: TxClient,
    trip: Trip,
    nextReassignCount: number,
    reason?: string,
  ): Promise<Trip> {
    const origin: LatLon = { lat: trip.originLat, lon: trip.originLon };
    const destination: LatLon = { lat: trip.destLat, lon: trip.destLon };
    const next = await tx.trip.update({
      where: { id: trip.id },
      data: {
        status: TripStatus.REASSIGNING,
        driverId: null,
        reassignCount: nextReassignCount,
        cancellationReason: reason ?? 'driver_cancelled',
      },
    });
    await emitTripRequested(tx, next, origin, destination);
    return next;
  }
}
