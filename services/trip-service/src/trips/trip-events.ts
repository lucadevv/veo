/**
 * Publicación de eventos de dominio del viaje (trip_event + outbox), en la transacción del caller.
 * Funciones PURAS extraídas de TripsService (SRP: el service orquesta las reglas; aquí vive el
 * vocabulario de eventos que un viaje emite). Todas reciben el `tx` para escribir en la MISMA
 * transacción Prisma que la mutación de dominio (FOUNDATION §6, regla #3 idempotencia financiera).
 */
import type { LatLon } from '@veo/utils';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox } from '@veo/database';
import type { Prisma, Trip } from '../generated/prisma';
import { readWaypoints } from './trip-view.mapper';

type TxClient = Prisma.TransactionClient;

/** Identidad del producer en los envelopes de evento que emite trip-service. */
export const PRODUCER = 'trip-service';

/**
 * Lote C1 · Vocabulario TIPADO de eventos de la PARADA mid-trip negociada (§4-ter: nombres como const,
 * nunca strings sueltos en el código de aplicación). Se usan en `recordTripEvent`/`enqueueOutbox` y en
 * los consumidores downstream (notification-service push al pasajero/conductor). Mismo formato `trip.*`.
 */
export const WAYPOINT_EVENTS = {
  /** El pasajero propuso una parada mid-trip; el conductor debe responder antes del TTL. */
  PROPOSED: 'trip.waypoint_proposed',
  /** El conductor aceptó: el waypoint se agregó al viaje y la tarifa se actualizó (delta estampado). */
  ACCEPTED: 'trip.waypoint_accepted',
  /** El conductor rechazó la parada propuesta. */
  REJECTED: 'trip.waypoint_rejected',
  /** Nadie respondió antes del TTL; el sweeper la expiró. */
  EXPIRED: 'trip.waypoint_expired',
} as const;
export type WaypointEvent = (typeof WAYPOINT_EVENTS)[keyof typeof WAYPOINT_EVENTS];

/** Inserta un evento de dominio en la tabla `trip_events` (historial auditable del viaje). */
export async function recordTripEvent(
  tx: TxClient,
  tripId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.tripEvent.create({
    data: { tripId, eventType, payload: payload as Prisma.InputJsonValue },
  });
}

/** Camino FIXED/legacy: emite `trip.requested` (dispatch arranca el matching secuencial). */
export async function emitTripRequested(
  tx: TxClient,
  trip: Trip,
  origin: LatLon,
  destination: LatLon,
): Promise<void> {
  const scheduled = trip.scheduledFor !== null;
  await recordTripEvent(tx, trip.id, 'trip.requested', {
    fareCents: trip.fareCents,
    distanceMeters: trip.distanceMeters,
    durationSeconds: trip.durationSeconds,
    surge: Number(trip.surgeMultiplier.toString()),
    category: trip.category,
    vehicleType: trip.vehicleType,
    scheduled,
  });
  await enqueueOutbox(
    tx,
    createEnvelope({
      eventType: 'trip.requested',
      producer: PRODUCER,
      payload: {
        tripId: trip.id,
        passengerId: trip.passengerId,
        origin,
        destination,
        fareCents: trip.fareCents,
        childMode: trip.childMode,
        // Ola 2B: dispatch filtra el matching por tipo de vehículo (MOTO solo a conductores MOTO).
        vehicleType: trip.vehicleType,
        // Ola 2B: si el viaje proviene de una reserva, dispatch puede incluirlo como "reservado".
        scheduled,
        // Ola 2B: paradas intermedias por el riel de eventos (dispatch ya no queda ciego; [] si es directo).
        waypoints: readWaypoints(trip),
      },
    }),
    trip.id,
  );
}

/**
 * PUJA (ADR 010 §2/§4) · entrada a la negociación. Inserta el evento de dominio + outbox
 * `trip.bid_posted` en la MISMA transacción de creación. dispatch abre el OfferBoard con este bid
 * y hace broadcast a conductores elegibles (ventana de puja = `bidWindowSec`). `bidCents` =
 * `fareCents` del viaje (ya validado ≥ piso). REEMPLAZA a `trip.requested` en el camino de puja.
 *
 * @param scheduled `true` SOLO cuando el bid nace de activar una reserva (cron → activateScheduledTrip):
 *   el pasajero NO está en la app y notification-service le mandará un push con deep-link al board.
 *   `false` en la puja inmediata y en el rebid (el pasajero ya está mirando el board).
 */
export async function emitBidPosted(
  tx: TxClient,
  trip: Trip,
  origin: LatLon,
  bidWindowSec: number,
  scheduled = false,
): Promise<void> {
  await recordTripEvent(tx, trip.id, 'trip.bid_posted', {
    bidCents: trip.fareCents,
    vehicleType: trip.vehicleType,
    windowSec: bidWindowSec,
    // H13 — sella el ciclo de negociación que abrió este bid (createTrip=1, rebid=trip.negotiationSeq+1).
    negotiationSeq: trip.negotiationSeq,
    scheduled,
  });
  await enqueueOutbox(
    tx,
    createEnvelope({
      eventType: 'trip.bid_posted',
      producer: PRODUCER,
      payload: {
        tripId: trip.id,
        passengerId: trip.passengerId,
        bidCents: trip.fareCents,
        vehicleType: trip.vehicleType,
        origin,
        windowSec: bidWindowSec,
        // H13 — dispatch persiste este seq en el board y lo estampa en dispatch.offer_accepted.
        negotiationSeq: trip.negotiationSeq,
        // BE-2 — el conductor las ve en su vista de puja (dispatch las guarda en el board).
        specialRequests: trip.specialRequests,
        // #1 — activación de reserva: notification-service pushea al pasajero (deep-link al board).
        scheduled,
        // Ola 2B: paradas intermedias por el riel de eventos (dispatch las recibe para el board; [] si directo).
        waypoints: readWaypoints(trip),
      },
    }),
    trip.id,
  );
}

// ───────────────────────── Lote C1 · Parada mid-trip negociada ─────────────────────────

/** Snapshot mínimo de una propuesta de parada para los emisores de eventos (sin acoplar al row Prisma). */
export interface WaypointProposalEventData {
  proposalId: string;
  tripId: string;
  passengerId: string;
  driverId?: string;
  point: { lat: number; lon: number };
  deltaFareCents: number;
  newFareCents: number;
}

/**
 * El pasajero PROPUSO una parada mid-trip. Inserta el trip_event + outbox `trip.waypoint_proposed` en
 * la MISMA transacción que crea la propuesta. notification-service pushea al CONDUCTOR (debe responder
 * antes del TTL). `expiresAt` viaja en ISO para que el cliente muestre la cuenta regresiva.
 */
export async function emitWaypointProposed(
  tx: TxClient,
  data: WaypointProposalEventData,
  expiresAt: Date,
): Promise<void> {
  const payload = {
    proposalId: data.proposalId,
    tripId: data.tripId,
    passengerId: data.passengerId,
    driverId: data.driverId,
    point: data.point,
    deltaFareCents: data.deltaFareCents,
    newFareCents: data.newFareCents,
    expiresAt: expiresAt.toISOString(),
  };
  await recordTripEvent(tx, data.tripId, WAYPOINT_EVENTS.PROPOSED, payload);
  await enqueueOutbox(
    tx,
    createEnvelope({ eventType: WAYPOINT_EVENTS.PROPOSED, producer: PRODUCER, payload }),
    data.tripId,
  );
}

/**
 * El conductor ACEPTÓ la parada: el waypoint ya se agregó al viaje y la tarifa se actualizó (delta
 * estampado server-side). trip_event + outbox `trip.waypoint_accepted` en la MISMA transacción que la
 * mutación del viaje. notification-service pushea al PASAJERO ("tu parada fue aceptada, +S/ X").
 */
export async function emitWaypointAccepted(
  tx: TxClient,
  data: WaypointProposalEventData,
): Promise<void> {
  const payload = {
    proposalId: data.proposalId,
    tripId: data.tripId,
    passengerId: data.passengerId,
    driverId: data.driverId,
    point: data.point,
    deltaFareCents: data.deltaFareCents,
    newFareCents: data.newFareCents,
  };
  await recordTripEvent(tx, data.tripId, WAYPOINT_EVENTS.ACCEPTED, payload);
  await enqueueOutbox(
    tx,
    createEnvelope({ eventType: WAYPOINT_EVENTS.ACCEPTED, producer: PRODUCER, payload }),
    data.tripId,
  );
}

/**
 * El conductor RECHAZÓ la parada. trip_event + outbox `trip.waypoint_rejected` en la MISMA transacción
 * que marca la propuesta REJECTED. notification-service pushea al PASAJERO ("tu parada fue rechazada").
 */
export async function emitWaypointRejected(
  tx: TxClient,
  data: WaypointProposalEventData,
): Promise<void> {
  const payload = {
    proposalId: data.proposalId,
    tripId: data.tripId,
    passengerId: data.passengerId,
    driverId: data.driverId,
    point: data.point,
  };
  await recordTripEvent(tx, data.tripId, WAYPOINT_EVENTS.REJECTED, payload);
  await enqueueOutbox(
    tx,
    createEnvelope({ eventType: WAYPOINT_EVENTS.REJECTED, producer: PRODUCER, payload }),
    data.tripId,
  );
}

/**
 * La propuesta EXPIRÓ sin respuesta (TTL vencido). La emite el sweeper en la MISMA transacción que la
 * marca EXPIRED. notification-service pushea al PASAJERO ("tu parada venció sin respuesta").
 */
export async function emitWaypointExpired(
  tx: TxClient,
  data: Pick<WaypointProposalEventData, 'proposalId' | 'tripId' | 'passengerId' | 'point'>,
): Promise<void> {
  const payload = {
    proposalId: data.proposalId,
    tripId: data.tripId,
    passengerId: data.passengerId,
    point: data.point,
  };
  await recordTripEvent(tx, data.tripId, WAYPOINT_EVENTS.EXPIRED, payload);
  await enqueueOutbox(
    tx,
    createEnvelope({ eventType: WAYPOINT_EVENTS.EXPIRED, producer: PRODUCER, payload }),
    data.tripId,
  );
}
