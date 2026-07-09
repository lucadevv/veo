/**
 * RatingsRepository — ÚNICO punto de acceso Prisma del agregado de calificaciones (schema 'rating'). Espeja
 * el patrón de `bookings.repository.ts`: encapsula el read/write split (réplica vs primary), el patrón
 * OUTBOX-EN-TRANSACCIÓN (la mutación de dominio y el INSERT de su evento van en la MISMA tx Prisma,
 * FOUNDATION §6) y expone métodos con NOMBRES DE DOMINIO — nunca filtra `PrismaClient` crudo hacia el service.
 *
 * SEAM con RatingsService: la LÓGICA DE DOMINIO (promedio rolling 30d, umbrales BR-D01/BR-I05, período de
 * gracia post-override, decisión `isNewFlag`) vive ENTERA en el service. Este repo solo hace acceso a datos.
 * Como el recálculo interleava lecturas y decisiones de dominio DENTRO de una misma transacción, el repo
 * expone `runInTransaction(work)` (dueño del `$transaction`) + métodos tx-scoped que reciben el `tx`: el
 * service ORQUESTA la secuencia (lee → decide con dominio → escribe) sin tocar nunca `this.prisma`.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import {
  Prisma,
  type Rating,
  type RatingAggregate,
  type SubjectRole,
} from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo, no lo dereferencia. */
export type RatingTx = Prisma.TransactionClient;

/** Datos para crear una calificación (los arma el service; el repo solo persiste). */
export type CreateRatingData = Prisma.RatingUncheckedCreateInput;

/** Escritura del agregado en términos de DOMINIO (número, no Decimal): el repo mapea a la representación Prisma. */
export interface AggregateWrite {
  role: SubjectRole;
  rollingAvg30d: number;
  count30d: number;
  flagged: boolean;
  flagReason: string | null;
  suspensionSuppressed: boolean;
  lastComputedAt: Date;
}

@Injectable()
export class RatingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Lecturas no críticas (réplica) ──────────────────────────────────────────────────────────────────

  /**
   * Pre-chequeo amistoso de existencia por viaje (GET-antes-de-crear). Solo el `id` (la UNIQUE de trip_id es
   * la garantía real ante carreras). Réplica.
   */
  findRatingByTripId(tripId: string): Promise<{ id: string } | null> {
    return this.prisma.read.rating.findUnique({
      where: { tripId },
      select: { id: true },
    });
  }

  /**
   * Calificación que UN rater dio en un viaje (GET /ratings?tripId, filtrada por el rater autenticado —
   * anti-IDOR: el filtro por `raterId` lo pone el service). Réplica.
   */
  findRatingByTripAndRater(tripId: string, raterId: string): Promise<Rating | null> {
    return this.prisma.read.rating.findFirst({ where: { tripId, raterId } });
  }

  /** Agregado de un sujeto (GET /ratings/aggregate/:subjectId y gRPC GetAggregate). Réplica. */
  getAggregate(subjectId: string): Promise<RatingAggregate | null> {
    return this.prisma.read.ratingAggregate.findUnique({ where: { subjectId } });
  }

  /** Todos los sujetos con agregado + su rol (input del barrido diario `recomputeAll`). Réplica. */
  listAggregateSubjects(): Promise<Array<{ subjectId: string; role: SubjectRole }>> {
    return this.prisma.read.ratingAggregate.findMany({
      select: { subjectId: true, role: true },
    });
  }

  // ── Transacciones (primary) ─────────────────────────────────────────────────────────────────────────

  /**
   * Dueño del `$transaction` (write). El service pasa `work`, que ORQUESTA lecturas y escrituras tx-scoped
   * del repo interleavadas con su lógica de dominio (recálculo, flags). Todo lo que corre en `work` es una
   * única unidad ACID (outbox-en-transacción).
   */
  runInTransaction<T>(work: (tx: RatingTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Crea la calificación dentro de la tx. */
  createRating(tx: RatingTx, data: CreateRatingData): Promise<Rating> {
    return tx.rating.create({ data });
  }

  /** Calificaciones de un sujeto dentro de la ventana rolling (createdAt ≥ cutoff). Solo `stars`. */
  findWindowRatings(
    tx: RatingTx,
    subjectId: string,
    cutoff: Date,
  ): Promise<Array<{ stars: number }>> {
    return tx.rating.findMany({
      where: { ratedId: subjectId, createdAt: { gte: cutoff } },
      select: { stars: true },
    });
  }

  /** Agregado previo del sujeto DENTRO de la tx (para decidir transición de flag / gracia). */
  findAggregateInTx(tx: RatingTx, subjectId: string): Promise<RatingAggregate | null> {
    return tx.ratingAggregate.findUnique({ where: { subjectId } });
  }

  /** Upsert del agregado recalculado. Mapea el avg de DOMINIO (número) a `Prisma.Decimal` para la columna. */
  async upsertAggregate(
    tx: RatingTx,
    subjectId: string,
    data: AggregateWrite,
  ): Promise<void> {
    const row = {
      role: data.role,
      rollingAvg30d: new Prisma.Decimal(data.rollingAvg30d),
      count30d: data.count30d,
      flagged: data.flagged,
      flagReason: data.flagReason,
      suspensionSuppressed: data.suspensionSuppressed,
      lastComputedAt: data.lastComputedAt,
    };
    await tx.ratingAggregate.upsert({
      where: { subjectId },
      create: { subjectId, ...row },
      update: row,
    });
  }

  /**
   * Limpia el flag STICKY (`flagged=false, flagReason=null`) y ACTIVA el período de gracia
   * (`suspensionSuppressed=true`) tras un `driver.reactivated`. NO recomputa desde las reseñas (eso
   * re-suspendería al instante) — la decisión de cuándo llamar es del service.
   */
  async clearAggregateFlag(tx: RatingTx, subjectId: string): Promise<void> {
    await tx.ratingAggregate.update({
      where: { subjectId },
      data: { flagged: false, flagReason: null, suspensionSuppressed: true },
    });
  }

  /** Persiste un evento en el outbox DENTRO de la tx (FOUNDATION §6). El service arma el envelope. */
  async insertOutboxEvent(
    tx: RatingTx,
    aggregateId: string,
    eventType: string,
    envelope: unknown,
  ): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        aggregateId,
        eventType,
        envelope: envelope as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
