/**
 * TripsRepository — ÚNICO punto de acceso Prisma del agregado Trip para el ciclo de vida escrito por
 * TripsService (esquema 'trip'). Espeja el patrón unit-of-work de `drivers.repository.ts`: expone
 * `runInTransaction(work)` (dueño del `$transaction` write) + métodos tx-scoped que reciben el `tx` opaco,
 * y encapsula el read/write split (réplica vs primario).
 *
 * SEAM con TripsService: TODA la LÓGICA DE DOMINIO (BR-T02 máquina de estados, BR-T05 tarifa, BR-T03
 * cancelación, BR-T07 modo niño con bcrypt del child-code, resolución de oferta/pricing, idempotencia
 * financiera, decisiones de reasignación) vive ENTERA en el service. Este repo solo hace acceso a datos y
 * CRISTALIZA los INVARIANTES DE QUERY del FSM que NO deben poder cambiarse desde afuera:
 *   - los CAS optimistas de transición llevan su predicado de estado en el WHERE del `updateMany`
 *     (`status: { in: sources }` para las 7 acciones de usuario y assign; `status = fromStatus` para los
 *     guards de carrera de puja/expiración/rebid; `status: { in: states }` para changeDestination) — NUNCA
 *     check-then-act; el service aporta las fuentes derivadas de la máquina y el destino;
 *   - `casApplyAgreedFare` lleva `agreedFareCents: null` HARDCODEADO (idempotencia once-ever del precio
 *     acordado, N7) junto al `negotiationSeq` del ciclo vigente (H13) y el guard de estado no-terminal (N9);
 *   - `anonymizeTripLocationByPassengerTx` lleva el scrub de coordenadas HARDCODEADO (derecho al olvido,
 *     Ley 29733): coords → 0, waypoints/polyline → null;
 * y el service ORQUESTA el outbox-en-transacción (recordTripEvent/enqueueOutbox, helpers de trip-events que
 * reciben el mismo `tx`) DENTRO de `runInTransaction`, AGUAS ABAJO del CAS, para que un claim perdido NO
 * emita el evento.
 */
import { Injectable } from '@nestjs/common';
import { TripStatus } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type Trip } from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo y a los emisores
 * de eventos (trip-events), sin dereferenciarlo. */
export type TripTx = Prisma.TransactionClient;

@Injectable()
export class TripsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Lecturas no transaccionales ─────────────────────────────────────────────────────────────────────

  /** Viaje por su idempotency-key de creación (réplica). Idempotencia del create: misma clave ⇒ mismo viaje. */
  findByIdempotencyKey(idempotencyKey: string): Promise<Trip | null> {
    return this.prisma.read.trip.findUnique({ where: { idempotencyKey } });
  }

  /**
   * ¿El pasajero tiene un viaje VIVO? Se lee del PRIMARIO (write) a propósito: el gate "un solo viaje vivo"
   * NO puede depender del lag de réplica (evita la carrera de doble-pedido). `liveStates` los aporta el
   * service (LIVE_STATES de la máquina). Devuelve solo el `id` (para el 409 ACTIVE_TRIP_EXISTS).
   */
  findLiveTripByPassenger(
    passengerId: string,
    liveStates: readonly TripStatus[],
  ): Promise<{ id: string } | null> {
    return this.prisma.write.trip.findFirst({
      where: { passengerId, status: { in: [...liveStates] } },
      select: { id: true },
      orderBy: { requestedAt: 'desc' },
    });
  }

  /** Viaje por id desde la RÉPLICA (handlers de consumidores Kafka: assign/offer_accepted/no_offers/bid_cancelled). */
  findByIdRead(id: string): Promise<Trip | null> {
    return this.prisma.read.trip.findUnique({ where: { id } });
  }

  /** El viaje PRE-RECOJO ya aceptado del conductor (reassignForDriverOffline), el más reciente. Réplica. */
  findPostAcceptTripByDriver(
    driverId: string,
    postAcceptStates: readonly TripStatus[],
  ): Promise<Trip | null> {
    return this.prisma.read.trip.findFirst({
      where: { driverId, status: { in: [...postAcceptStates] } },
      orderBy: { assignedAt: 'desc' },
    });
  }

  /** Ids de TODOS los viajes de un pasajero (anonymizePassenger: señal de purga de video por viaje). Réplica. */
  findTripIdsByPassenger(passengerId: string): Promise<{ id: string }[]> {
    return this.prisma.read.trip.findMany({ where: { passengerId }, select: { id: true } });
  }

  /** Viaje por id desde el PRIMARIO (mustFind: read-after-write del detalle antes de una mutación). */
  findByIdOnPrimary(id: string): Promise<Trip | null> {
    return this.prisma.write.trip.findUnique({ where: { id } });
  }

  // ── Escrituras no transaccionales (primario) ─────────────────────────────────────────────────────────

  /** Sella el cierre post-viaje del pasajero (`passengerClosedAt`). Devuelve la fila actualizada. */
  updatePassengerClosedAt(id: string, passengerClosedAt: Date): Promise<Trip> {
    return this.prisma.write.trip.update({ where: { id }, data: { passengerClosedAt } });
  }

  // ── Transacciones (primario · unit-of-work) ──────────────────────────────────────────────────────────

  /**
   * Dueño del `$transaction` (write). El service pasa `work`, que ORQUESTA el CAS + la relectura + el
   * outbox-en-transacción (recordTripEvent/enqueueOutbox reciben el mismo `tx`) como una única unidad ACID.
   */
  runInTransaction<T>(work: (tx: TripTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Crea el viaje, DENTRO de la tx. El service arma la `data` de dominio (mapeo completo de la fila). */
  createTripTx(tx: TripTx, data: Prisma.TripUncheckedCreateInput): Promise<Trip> {
    return tx.trip.create({ data });
  }

  /** Viaje por id DENTRO de la tx (rama count===0 del CAS: error honesto con el `from` real). */
  findByIdTx(tx: TripTx, id: string): Promise<Trip | null> {
    return tx.trip.findUnique({ where: { id } });
  }

  /** Relee el viaje ya escrito DENTRO de la tx (invariante: la fila existe tras un CAS que movió). */
  findByIdOrThrowTx(tx: TripTx, id: string): Promise<Trip> {
    return tx.trip.findUniqueOrThrow({ where: { id } });
  }

  // ── CAS de transición del FSM (predicado de estado en el WHERE · el service aporta fuentes/destino) ──

  /**
   * CAS GENÉRICO de las transiciones OPERADAS POR EL USUARIO (accept/arriving/arrived/start/complete/cancel/
   * fail) y de `assign`: mueve a `to` en el MISMO statement que valida que el estado era fuente legal
   * (`status: { in: sources }` en el WHERE). count>0 ⇒ movió; count===0 ⇒ no existía o ya no era fuente (el
   * service relee para el error honesto). El destino `to` se estampa en `data` junto a los campos del service.
   */
  casMoveStatus(
    tx: TripTx,
    id: string,
    sources: readonly TripStatus[],
    to: TripStatus,
    data: Prisma.TripUpdateManyMutationInput,
  ): Promise<{ count: number }> {
    return tx.trip.updateMany({
      where: { id, status: { in: [...sources] } },
      data: { status: to, ...data },
    });
  }

  /**
   * CAS de changeDestination: pisa destino/tarifa/ruta SOLO si el viaje SIGUE en un estado editable
   * (`status: { in: states }` en el WHERE, aportado por el service). NO cambia `status` (no es transición).
   */
  casUpdateInStates(
    tx: TripTx,
    id: string,
    states: readonly TripStatus[],
    data: Prisma.TripUpdateManyMutationInput,
  ): Promise<{ count: number }> {
    return tx.trip.updateMany({ where: { id, status: { in: [...states] } }, data });
  }

  /**
   * CAS con guard de UN estado observado (`status = fromStatus`): puja abierta (expireFromNoOffers,
   * cancelFromBid), re-puja (rebid). Solo escribe si el viaje SIGUE en el estado leído; count===0 ⇒ otro
   * actor ganó la carrera → el service trata como no-op idempotente.
   */
  casGuardedUpdate(
    tx: TripTx,
    id: string,
    fromStatus: TripStatus,
    data: Prisma.TripUpdateManyMutationInput,
  ): Promise<{ count: number }> {
    return tx.trip.updateMany({ where: { id, status: fromStatus }, data });
  }

  /**
   * CAS del PRECIO ACORDADO (applyAgreedFare · money-path). Escribe `fareCents = agreedFareCents = priceCents`
   * SOLO si, atómicamente: (H13) el `negotiationSeq` es el del ciclo vigente; (N7) `agreedFareCents` SIGUE
   * null (idempotencia once-ever HARDCODEADA — una redelivery NO reescribe la tarifa); (N9) el viaje NO está
   * en un terminal (`status: { in: applicableStates }`). count===0 ⇒ stale/ya aplicado/terminal → no-op.
   */
  casApplyAgreedFare(
    tx: TripTx,
    tripId: string,
    negotiationSeq: number,
    applicableStates: readonly TripStatus[],
    priceCents: number,
  ): Promise<{ count: number }> {
    return tx.trip.updateMany({
      where: {
        id: tripId,
        negotiationSeq,
        agreedFareCents: null,
        status: { in: [...applicableStates] },
      },
      data: { fareCents: priceCents, agreedFareCents: priceCents },
    });
  }

  // ── Derecho al olvido (Ley 29733) ────────────────────────────────────────────────────────────────────

  /**
   * Anonimiza la PII de localización de TODOS los viajes del pasajero, DENTRO de la tx. El scrub va
   * HARDCODEADO (invariante de borrado): coords → 0, waypoints/polyline → null. Conserva la fila (integridad
   * financiera/auditoría). Idempotente: es una sobre-escritura determinista. Devuelve las filas tocadas.
   */
  anonymizeTripLocationByPassengerTx(
    tx: TripTx,
    passengerId: string,
  ): Promise<{ count: number }> {
    return tx.trip.updateMany({
      where: { passengerId },
      data: {
        originLat: 0,
        originLon: 0,
        destLat: 0,
        destLon: 0,
        waypoints: Prisma.DbNull,
        routePolyline: null,
      },
    });
  }
}
