/**
 * RatingsService — calificaciones post-viaje (1-5), promedio rolling 30d y flags (BR-D01/BR-I05).
 *
 * Reglas:
 *  - Un único rating por viaje (UNIQUE trip_id). Al crear → publica `rating.created` (outbox) y
 *    recalcula el agregado del sujeto calificado DENTRO de la misma transacción (atómico).
 *  - Promedio rolling: solo calificaciones de los últimos `ROLLING_WINDOW_DAYS` días.
 *  - BR-D01 (conductor): rollingAvg < 4.3 → "review"; < 4.0 → "suspension" (emite `driver.flagged`).
 *  - BR-I05 (pasajero): rollingAvg < 4.0 → "reverification" (marca + emite `passenger.flagged`).
 *  - El evento de flag se emite solo en la TRANSICIÓN a un (nuevo) estado de flag, para no spamear.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createEnvelope } from '@veo/events';
import { isUniqueViolation } from '@veo/database';
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError } from '@veo/utils';
import { uuidv7 } from '@veo/utils';
import { TripStatus } from '@veo/shared-types';
import { Prisma, type SubjectRole } from '../generated/prisma';
import { PrismaService } from '../infra/prisma.service';
import type { Env } from '../config/env.schema';
import { TRIP_CLIENT, type TripClient } from '../trip/trip-client.port';
import { averageOfStars, windowCutoff, type RollingAverage } from './domain/rolling-average';
import { evaluateFlag, type FlagThresholds, type FlagReason } from './domain/flags';

const PRODUCER = 'rating-service';

/** Resultado de un recálculo de agregado. */
export interface RecomputeResult extends RollingAverage {
  flagged: boolean;
  reason: FlagReason | null;
}

@Injectable()
export class RatingsService {
  private readonly logger = new Logger(RatingsService.name);
  private readonly windowDays: number;
  private readonly thresholds: FlagThresholds;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    @Inject(TRIP_CLIENT) private readonly tripClient: TripClient,
  ) {
    this.windowDays = config.getOrThrow<number>('ROLLING_WINDOW_DAYS');
    this.thresholds = {
      driverReview: config.getOrThrow<number>('DRIVER_REVIEW_THRESHOLD'),
      driverSuspension: config.getOrThrow<number>('DRIVER_SUSPENSION_THRESHOLD'),
      passengerReverify: config.getOrThrow<number>('PASSENGER_REVERIFY_THRESHOLD'),
    };
  }

  /** Crea la calificación, publica `rating.created` y recalcula el agregado del sujeto (misma tx). */
  async create(
    raterId: string,
    input: {
      tripId: string;
      ratedId: string;
      ratedRole: SubjectRole;
      stars: number;
      comment?: string;
    },
  ): Promise<RatingEntity> {
    // Gate fail-closed (cierre de auditoría): un viaje solo se califica si EXISTE, está COMPLETED y el
    // rater participó, calificando a su CONTRAPARTE. Se valida ANTES de tocar la DB. Si trip-service no
    // responde, getTrip PROPAGA el error (no se atrapa): sin verificación NO se permite calificar.
    await this.assertRatableTrip(raterId, input);

    // Pre-chequeo amistoso; la UNIQUE de trip_id es la garantía real ante carreras.
    const existing = await this.prisma.read.rating.findUnique({
      where: { tripId: input.tripId },
      select: { id: true },
    });
    if (existing) throw new ConflictError('Ya existe una calificación para este viaje');

    const ratingId = uuidv7();
    const now = new Date();

    try {
      const rating = await this.prisma.write.$transaction(async (tx) => {
        const created = await tx.rating.create({
          data: {
            id: ratingId,
            tripId: input.tripId,
            raterId,
            ratedId: input.ratedId,
            stars: input.stars,
            comment: input.comment ?? null,
          },
        });

        // `rating.created`: el campo `driverId` del contrato transporta el id del sujeto calificado.
        await this.enqueue(
          tx,
          'rating.created',
          { ratingId, tripId: input.tripId, driverId: input.ratedId, stars: input.stars },
          input.ratedId,
        );

        // Recálculo atómico del agregado (incluye la calificación recién creada).
        await this.recomputeWithinTx(tx, input.ratedId, input.ratedRole, now);
        return created;
      });
      return toEntity(rating);
    } catch (err) {
      if (isUniqueViolation(err, 'tripId')) {
        throw new ConflictError('Ya existe una calificación para este viaje');
      }
      throw err;
    }
  }

  /**
   * Gate de validación del viaje (fail-closed). Valida contra trip-service (fuente autoritativa):
   *  - El viaje EXISTE (si no → NotFoundError).
   *  - Está COMPLETED (si no → InvalidStateError; calificar un viaje en curso/cancelado es un dato corrupto).
   *  - El rater PARTICIPÓ: es el pasajero o el conductor del viaje (si no → ForbiddenError).
   *  - El ratedId es la CONTRAPARTE: rater pasajero → califica al conductor y viceversa (si no → ForbiddenError).
   * Si trip-service no responde, getTrip lanza y el error PROPAGA (no se atrapa) → no se califica.
   */
  private async assertRatableTrip(
    raterId: string,
    input: { tripId: string; ratedId: string },
  ): Promise<void> {
    const trip = await this.tripClient.getTrip(input.tripId);
    if (!trip) throw new NotFoundError('Viaje no encontrado');

    if (trip.status !== TripStatus.COMPLETED) {
      throw new InvalidStateError('Solo se califica un viaje completado');
    }

    const isPassenger = raterId === trip.passengerId;
    const isDriver = raterId === trip.driverId;
    if (!isPassenger && !isDriver) {
      throw new ForbiddenError('No participaste de este viaje');
    }

    // La contraparte exacta: el pasajero solo califica al conductor y el conductor solo al pasajero.
    const counterparty = isPassenger ? trip.driverId : trip.passengerId;
    if (input.ratedId !== counterparty) {
      throw new ForbiddenError('El calificado no es la contraparte del viaje');
    }
  }

  /**
   * Calificación que UN rater dio en un viaje (GET /ratings?tripId, filtrada por el rater autenticado).
   * `null` si ese rater no calificó ese viaje. El filtro por `raterId` es la garantía anti-IDOR Y la
   * semántica correcta: un viaje puede tener DOS ratings (pasajero→conductor y conductor→pasajero); el
   * pasajero debe ver SOLO el suyo (rater=él, sujeto=conductor), nunca el que el conductor le puso.
   * Como hay UNIQUE(trip_id), hoy existe a lo sumo un rating por viaje, pero filtrar por rater es
   * correcto-por-construcción ante una futura relajación de esa restricción.
   */
  async findByTripForRater(tripId: string, raterId: string): Promise<RatingEntity | null> {
    const r = await this.prisma.read.rating.findFirst({ where: { tripId, raterId } });
    return r ? toEntity(r) : null;
  }

  /** Agregado de un sujeto (GET /ratings/aggregate/:subjectId y gRPC GetAggregate). */
  async getAggregate(subjectId: string): Promise<AggregateEntity | null> {
    const a = await this.prisma.read.ratingAggregate.findUnique({ where: { subjectId } });
    return a ? toAggregate(a) : null;
  }

  /** Recalcula el agregado de un sujeto en su propia transacción (usado por el cron). */
  async recomputeAggregate(
    subjectId: string,
    role: SubjectRole,
    now: Date = new Date(),
  ): Promise<RecomputeResult> {
    return this.prisma.write.$transaction((tx) => this.recomputeWithinTx(tx, subjectId, role, now));
  }

  /**
   * Recálculo diario (ventana deslizante) de TODOS los agregados conocidos + re-evaluación de flags.
   * Devuelve cuántos agregados se recalcularon.
   */
  async recomputeAll(now: Date = new Date()): Promise<number> {
    const subjects = await this.prisma.read.ratingAggregate.findMany({
      select: { subjectId: true, role: true },
    });
    let processed = 0;
    for (const s of subjects) {
      try {
        await this.recomputeAggregate(s.subjectId, s.role, now);
        processed += 1;
      } catch (err) {
        this.logger.error({ err, subjectId: s.subjectId }, 'recálculo de agregado falló');
      }
    }
    return processed;
  }

  /** Núcleo del recálculo dentro de una transacción dada. */
  private async recomputeWithinTx(
    tx: Prisma.TransactionClient,
    subjectId: string,
    role: SubjectRole,
    now: Date,
  ): Promise<RecomputeResult> {
    const cutoff = windowCutoff(this.windowDays, now);
    const rows = await tx.rating.findMany({
      where: { ratedId: subjectId, createdAt: { gte: cutoff } },
      select: { stars: true },
    });
    const { avg, count } = averageOfStars(rows.map((r) => r.stars));
    const decision = evaluateFlag(role, avg, count, this.thresholds);

    const prev = await tx.ratingAggregate.findUnique({ where: { subjectId } });

    const data = {
      role,
      rollingAvg30d: new Prisma.Decimal(avg),
      count30d: count,
      flagged: decision.flagged,
      flagReason: decision.reason,
      lastComputedAt: now,
    };
    await tx.ratingAggregate.upsert({
      where: { subjectId },
      create: { subjectId, ...data },
      update: data,
    });

    // Emitir evento de flag solo en la transición a un (nuevo) estado/razón de flag.
    const isNewFlag =
      decision.flagged && (prev === null || !prev.flagged || prev.flagReason !== decision.reason);
    if (isNewFlag && decision.reason) {
      await this.enqueueFlagEvent(tx, role, subjectId, avg, decision.reason);
    }

    return { avg, count, flagged: decision.flagged, reason: decision.reason };
  }

  private async enqueueFlagEvent(
    tx: Prisma.TransactionClient,
    role: SubjectRole,
    subjectId: string,
    rollingAvg: number,
    reason: FlagReason,
  ): Promise<void> {
    if (role === 'DRIVER') {
      await this.enqueue(
        tx,
        'driver.flagged',
        { driverId: subjectId, rollingAvg, reason },
        subjectId,
      );
    } else {
      // NOTA: `passenger.flagged` aún no está en EVENT_SCHEMAS de @veo/events (ver README/docs).
      await this.enqueue(
        tx,
        'passenger.flagged',
        { passengerId: subjectId, rollingAvg, reason },
        subjectId,
      );
    }
  }

  /** Encola un evento en el outbox dentro de la transacción (FOUNDATION §6). */
  private async enqueue(
    tx: Prisma.TransactionClient,
    eventType: string,
    payload: unknown,
    aggregateId: string,
  ): Promise<void> {
    const envelope = createEnvelope({ eventType, producer: PRODUCER, payload });
    await tx.outboxEvent.create({
      data: {
        aggregateId,
        eventType: envelope.eventType,
        envelope: envelope as unknown as Prisma.InputJsonValue,
      },
    });
  }
}

/** Entidad de salida (mapea Decimal/null para HTTP y gRPC). */
export interface RatingEntity {
  id: string;
  tripId: string;
  raterId: string;
  ratedId: string;
  stars: number;
  comment: string | null;
  createdAt: Date;
}

export interface AggregateEntity {
  subjectId: string;
  role: SubjectRole;
  rollingAvg30d: number;
  count30d: number;
  flagged: boolean;
  flagReason: string | null;
  lastComputedAt: Date;
}

function toEntity(r: {
  id: string;
  tripId: string;
  raterId: string;
  ratedId: string;
  stars: number;
  comment: string | null;
  createdAt: Date;
}): RatingEntity {
  return {
    id: r.id,
    tripId: r.tripId,
    raterId: r.raterId,
    ratedId: r.ratedId,
    stars: r.stars,
    comment: r.comment,
    createdAt: r.createdAt,
  };
}

function toAggregate(a: {
  subjectId: string;
  role: SubjectRole;
  rollingAvg30d: Prisma.Decimal;
  count30d: number;
  flagged: boolean;
  flagReason: string | null;
  lastComputedAt: Date;
}): AggregateEntity {
  return {
    subjectId: a.subjectId,
    role: a.role,
    rollingAvg30d: Number(a.rollingAvg30d),
    count30d: a.count30d,
    flagged: a.flagged,
    flagReason: a.flagReason,
    lastComputedAt: a.lastComputedAt,
  };
}
