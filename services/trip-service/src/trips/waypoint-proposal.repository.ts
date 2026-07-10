/**
 * WaypointProposalRepository — ÚNICO punto de acceso Prisma del sub-dominio PARADA mid-trip negociada
 * (esquema 'trip'). Unit-of-work al estilo de `drivers.repository.ts`: `runInTransaction(work)` + métodos
 * tx-scoped que reciben el `tx` opaco. La LÓGICA (cálculo del delta server-authoritative, gates de estado,
 * TTL, idempotencia, traducción del P2002, emisión de eventos) vive ENTERA en el WaypointProposalService.
 * El repo solo ejecuta el acceso a datos y CRISTALIZA los guards de carrera (CAS `status = PROPOSED`, el
 * guard extra `expiresAt <= now` de la expiración, el guard `status IN proposables` del viaje) en el WHERE.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { TripStatus } from '@veo/shared-types';
import { WaypointProposalStatus } from './domain/waypoint-proposal';
import type { Prisma, Trip, TripWaypointProposal } from '../generated/prisma';

/** Handle de transacción opaco para el service. */
export type TripTx = Prisma.TransactionClient;

/** Fila de candidata a expirar (snapshot mínimo + el passengerId del viaje, para el push). */
export type ExpiredCandidateRow = Pick<TripWaypointProposal, 'id' | 'tripId' | 'lat' | 'lon'> & {
  trip: { passengerId: string };
};

/** Propuesta con el passengerId de su viaje (expireProposal). */
export type ProposalWithTrip = TripWaypointProposal & { trip: { passengerId: string } };

@Injectable()
export class WaypointProposalRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Viaje por id desde el PRIMARIO (mustFindTrip: read-after-write). */
  findTripByIdOnPrimary(id: string): Promise<Trip | null> {
    return this.prisma.write.trip.findUnique({ where: { id } });
  }

  /** La propuesta PROPOSED viva del viaje (chequeo de "una sola activa" + relookup del P2002). Réplica. */
  findLiveProposalByTrip(tripId: string): Promise<TripWaypointProposal | null> {
    return this.prisma.read.tripWaypointProposal.findFirst({
      where: { tripId, status: WaypointProposalStatus.PROPOSED },
    });
  }

  /** Propuesta por id (réplica). */
  findProposalById(proposalId: string): Promise<TripWaypointProposal | null> {
    return this.prisma.read.tripWaypointProposal.findUnique({ where: { id: proposalId } });
  }

  /** Propuesta por id + el passengerId de su viaje (expireProposal). Réplica. */
  findProposalByIdWithTrip(proposalId: string): Promise<ProposalWithTrip | null> {
    return this.prisma.read.tripWaypointProposal.findUnique({
      where: { id: proposalId },
      include: { trip: { select: { passengerId: true } } },
    });
  }

  /** Candidatas PROPOSED con `expiresAt <= now` (pre-filtro del sweeper), acotadas por `limit`. Réplica. */
  findExpiredCandidates(now: Date, limit: number): Promise<ExpiredCandidateRow[]> {
    return this.prisma.read.tripWaypointProposal.findMany({
      where: { status: WaypointProposalStatus.PROPOSED, expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
      select: {
        id: true,
        tripId: true,
        lat: true,
        lon: true,
        trip: { select: { passengerId: true } },
      },
    });
  }

  /** Dueño del `$transaction` (write · unit-of-work). */
  runInTransaction<T>(work: (tx: TripTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Crea la propuesta, DENTRO de la tx. El service arma la `data` de dominio. */
  createProposalTx(
    tx: TripTx,
    data: Prisma.TripWaypointProposalUncheckedCreateInput,
  ): Promise<TripWaypointProposal> {
    return tx.tripWaypointProposal.create({ data });
  }

  /**
   * CAS de la propuesta: aplica `data` SOLO si SIGUE PROPOSED (`status = PROPOSED` HARDCODEADO en el WHERE)
   * → no doble-accept ni pisar un expire/reject concurrente. El service aporta el destino en `data`.
   */
  casMoveProposalTx(
    tx: TripTx,
    proposalId: string,
    data: Prisma.TripWaypointProposalUpdateManyMutationInput,
  ): Promise<{ count: number }> {
    return tx.tripWaypointProposal.updateMany({
      where: { id: proposalId, status: WaypointProposalStatus.PROPOSED },
      data,
    });
  }

  /**
   * CAS de la EXPIRACIÓN: PROPOSED → EXPIRED SOLO si sigue PROPOSED Y `expiresAt <= now` (ambos guards
   * HARDCODEADOS). count===0 ⇒ otro actor (respond/otro tick) ya la movió → no-op idempotente.
   */
  casExpireProposalTx(
    tx: TripTx,
    proposalId: string,
    now: Date,
    data: Prisma.TripWaypointProposalUpdateManyMutationInput,
  ): Promise<{ count: number }> {
    return tx.tripWaypointProposal.updateMany({
      where: {
        id: proposalId,
        status: WaypointProposalStatus.PROPOSED,
        expiresAt: { lte: now },
      },
      data,
    });
  }

  /**
   * CAS de ESTADO DEL VIAJE al aceptar la parada: pisa waypoints/tarifa/ruta SOLO si el viaje SIGUE en un
   * estado proponible (`status IN proposableStates` en el WHERE, aportado por el service desde el dominio).
   * count===0 ⇒ el viaje terminó entre propose y respond → el service lanza y REVIERTE el CAS de la propuesta.
   */
  casApplyWaypointToTripTx(
    tx: TripTx,
    tripId: string,
    proposableStates: readonly TripStatus[],
    data: Prisma.TripUpdateManyMutationInput,
  ): Promise<{ count: number }> {
    return tx.trip.updateMany({
      where: { id: tripId, status: { in: [...proposableStates] } },
      data,
    });
  }
}
