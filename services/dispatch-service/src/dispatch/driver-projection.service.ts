/**
 * DriverProjectionService — proyección LOCAL de métricas del conductor para el scoring (BR-T06).
 *
 * Decisión de arquitectura (documentada en README/docs/events.md):
 * dispatch NO hace join cross-servicio a las tablas de identity/rating. En su lugar mantiene una
 * proyección propia (`driver_stats`) poblada por eventos de dominio:
 *   - rating.created  → media móvil del rating.
 *   - driver.flagged  → rating promedio recalculado (rollingAvg) impuesto.
 *   - trip.completed  → último viaje + contador de completados (driverId resuelto vía el match aceptado).
 *   - trip.cancelled  → contador de cancelaciones del conductor (para la tasa de cancelación).
 * Así el scoring lee de una fuente local de baja latencia y dispatch queda desacoplado.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createEnvelope } from '@veo/events';
import { PrismaService } from '../infra/prisma.service';
import { Prisma } from '../generated/prisma';
import type { Env } from '../config/env.schema';

/** Stats normalizadas que consume el scorer. */
export interface DriverScoreStats {
  avgRating: number;
  secondsSinceLastTrip: number;
  cancellationRate: number;
}

/// Segundos atribuidos a un conductor sin viajes registrados (término de actividad ≈ 0).
const NO_TRIP_SECONDS = 1_000_000_000;
const DEFAULT_RATING = 5.0;
/// eventType en el wire de la auto-suspensión por exceso de cancelaciones (cero magic strings; casa con
/// EVENT_SCHEMAS de @veo/events y con la const del consumer de identity). topicForEvent lo mapea a 'driver'.
const DRIVER_EXCESSIVE_CANCELLATIONS = 'driver.excessive_cancellations';
/// Namespace fijo del advisory lock XACT-scoped que serializa el procesamiento de cancelaciones POR-CONDUCTOR
/// (cierra la carrera cross-réplica del cruce del umbral). Es el primer int4 de pg_advisory_xact_lock(int4,int4);
/// el segundo es hashtext(driverId). Aísla este lock de cualquier otro pg_advisory del schema. Valor arbitrario
/// pero ESTABLE (todas las réplicas deben usar el MISMO namespace para compartir el espacio de locks).
const CANCELLATION_LOCK_NS = 0x4361_6e63; // 'Canc' en ASCII — namespace legible, estable entre réplicas.

@Injectable()
export class DriverProjectionService {
  private readonly logger = new Logger(DriverProjectionService.name);
  private readonly windowMs: number;
  private readonly threshold: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.windowMs = config.getOrThrow<number>('CANCELLATION_WINDOW_HOURS') * 60 * 60 * 1000;
    this.threshold = config.getOrThrow<number>('CANCELLATION_THRESHOLD');
  }

  async onRatingCreated(driverId: string, stars: number): Promise<void> {
    await this.prisma.write.$transaction(async (tx) => {
      const existing = await tx.driverStats.findUnique({ where: { driverId } });
      const prevCount = existing?.ratingCount ?? 0;
      const prevAvg = existing ? Number(existing.avgRating.toString()) : DEFAULT_RATING;
      const newCount = prevCount + 1;
      const newAvg = (prevAvg * prevCount + stars) / newCount;
      await tx.driverStats.upsert({
        where: { driverId },
        create: { driverId, avgRating: newAvg, ratingCount: 1 },
        update: { avgRating: newAvg, ratingCount: newCount },
      });
    });
  }

  async onDriverFlagged(driverId: string, rollingAvg: number): Promise<void> {
    await this.prisma.write.driverStats.upsert({
      where: { driverId },
      create: { driverId, avgRating: rollingAvg },
      update: { avgRating: rollingAvg },
    });
  }

  async onTripCompleted(driverId: string, completedAt: Date): Promise<void> {
    await this.prisma.write.$transaction(async (tx) => {
      const existing = await tx.driverStats.findUnique({ where: { driverId } });
      await tx.driverStats.upsert({
        where: { driverId },
        create: { driverId, completedTrips: 1, lastTripAt: completedAt },
        update: { completedTrips: (existing?.completedTrips ?? 0) + 1, lastTripAt: completedAt },
      });
    });
  }

  /**
   * VENTANA ROLLING de 24h de cancelaciones del conductor → auto-suspensión por exceso (decisión del dueño ·
   * compliance/seguridad). Hace DOS cosas en UNA transacción, ambas IDEMPOTENTES por el natural key
   * `(driverId, tripId)`:
   *   - el contador LIFELONG (`cancelledTrips`) que alimenta la TASA de cancelación del scoring (BR-T06) y
   *     NUNCA se poda;
   *   - la ventana RECIENTE que decide la suspensión.
   *
   * Pasos:
   *   1. REGISTRA la cancelación con `createMany({ skipDuplicates: true })` sobre el natural key
   *      `(driverId, tripId)`. `skipDuplicates` se compila a Postgres `INSERT ... ON CONFLICT DO NOTHING`:
   *      el conflicto del `@unique([driverId, tripId])` NO lanza error y, sobre todo, NO ABORTA la transacción
   *      (a diferencia de `create`, que lanza P2002 y deja la tx en estado `25P02: current transaction is
   *      aborted` — cualquier statement posterior fallaría → re-throw → crash-loop de partición de Kafka).
   *      El `count` que devuelve es la SEÑAL ATÓMICA de "cancelación NUEVA": `wasNew = count === 1`. Una
   *      re-entrega del MISMO `trip.cancelled` (at-least-once de Kafka, o el retry de un handler que falló más
   *      abajo) da `count === 0` → `wasNew = false`. NO usamos `create`+catch porque capturar el P2002 DENTRO
   *      de la `$transaction` no des-aborta la tx en Postgres (el patrón correcto captura el unique FUERA del
   *      callback; acá lo evitamos de raíz con `skipDuplicates`).
   *   2. EARLY-RETURN si `!wasNew` (re-entrega del mismo `(driverId, tripId)`): la PRIMERA entrega ya hizo TODO
   *      (lifelong + poda + conteo + emisión, todo COMMITEADO atómicamente con la fila — ver atomicidad abajo).
   *      La re-entrega es un NO-OP TOTAL: no re-incrementa la tasa, no re-poda, no re-cuenta y NUNCA alcanza el
   *      `outboxEvent.create` → el `@unique(dedupKey)` del outbox NO se choca jamás en el flujo normal. Esto
   *      elimina de RAÍZ el 25P02 (no relocaliza la captura de P2002): nunca hay un unique-violation que tragar
   *      dentro de la tx.
   *   3. INCREMENTA el contador LIFELONG `cancelledTrips` (tasa de cancelación del scoring, NUNCA se poda).
   *      Solo se llega acá en la PRIMERA entrega → idempotente bajo redelivery/retry por construcción.
   *   4. PODA las cancelaciones más viejas que la ventana (deleteMany occurredAt < cutoff): mantiene la tabla
   *      acotada y el conteo correcto.
   *   5. CUENTA las de la ventana (occurredAt >= cutoff). La fila recién insertada está incluida.
   *   6. Si el conteo CRUZA EXACTAMENTE el umbral (count === threshold) emite `driver.excessive_cancellations`
   *      UNA vez por OUTBOX (misma tx, FOUNDATION §6). "=== threshold" (no ">=") garantiza una sola emisión por
   *      cruce 4→5: en la 6ª, 7ª… cancelación el count ya es > threshold y NO re-emite. Como solo se llega acá
   *      en la PRIMERA entrega del `tripId`, el `dedupKey` (atado a ese `tripId`) NUNCA colisiona en el flujo
   *      normal → el `outboxEvent.create` no necesita capturar P2002. Si por contrato fallara (otro error),
   *      BURBUJEA → rollback de TODA la tx (fila incluida) → Kafka re-entrega → re-procesa (la fila se revirtió
   *      → `wasNew` vuelve a ser true) → NO se pierde la emisión.
   *
   * CONCURRENCIA CROSS-RÉPLICA (paso 0, advisory lock): el `count === threshold` es exacto SOLO si las
   *   cancelaciones del MISMO conductor se procesan EN SERIE. Bajo replicas>=2 + particionado de Kafka por
   *   tripId, dos cancelaciones del mismo conductor en trips distintos corren CONCURRENTEMENTE en pods distintos;
   *   en Read Committed cada tx ve el count PRE-insert de la otra → el cruce 4→5 se pierde y NUNCA se emite. El
   *   `pg_advisory_xact_lock(ns, hashtext(driverId))` al INICIO de la tx serializa por-conductor: la 2ª tx espera
   *   el commit de la 1ª, re-lee el count con su fila visible, y detecta el cruce EXACTAMENTE una vez.
   *
   * ATOMICIDAD / exactly-once (insert + lifelong + poda + count + emit en la MISMA `$transaction`):
   *   - Si la tx COMMITEA → la fila de cancelación Y la fila de outbox quedan juntas. Una re-entrega posterior
   *     ve `count === 0` (la fila ya existe) → early-return → no re-emite. Exactly-once.
   *   - Si la tx CRASHEA pre-commit (entre el insert y el emit) → ROLLBACK revierte AMBAS (la fila NO queda).
   *     La re-entrega de Kafka re-inserta (`wasNew = true`) → re-procesa íntegro → emite. NO se pierde la
   *     suspensión. El early-return solo ocurre cuando la 1ª corrida COMMITEÓ fila+outbox juntos → seguro.
   *
   * `driverId` = id de PERFIL (lo resolvió el consumer del payload enriquecido, igual espacio que `driverForTrip`).
   * `tripId` = id del viaje cancelado (idempotencia). `occurredAt` = momento real de la cancelación (del envelope).
   */
  async registerCancellationInWindow(
    driverId: string,
    tripId: string,
    occurredAt: Date,
  ): Promise<void> {
    const cutoff = new Date(occurredAt.getTime() - this.windowMs);
    await this.prisma.write.$transaction(async (tx) => {
      // 0) LOCK XACT-SCOPED POR-CONDUCTOR — cierra la carrera cross-réplica del cruce del umbral (ALTA).
      //    dispatch corre replicas>=2 y Kafka particiona por aggregateId=tripId, así que DOS cancelaciones del
      //    MISMO conductor en trips DISTINTOS caen en particiones/pods DISTINTOS → se procesan CONCURRENTEMENTE.
      //    Sin lock, en Read Committed (default) ambas tx ven el count PRE-insert de la otra (no ven su fila
      //    aún-no-commiteada): si llegan la (THRESHOLD-1)-ésima y la THRESHOLD-ésima a la vez, NINGUNA ve count
      //    === THRESHOLD → el cruce 4→5 se PIERDE → `driver.excessive_cancellations` NUNCA se emite → el
      //    conductor abusivo no se suspende. (El dedupKey protege contra DOBLE emisión, NO contra emisión
      //    PERDIDA.) `pg_advisory_xact_lock` toma un lock a nivel de sesión-transacción atado al hash del
      //    driverId: la 2ª tx del MISMO conductor BLOQUEA hasta que la 1ª COMMITEA (o hace rollback) → re-lee el
      //    count YA con la fila de la 1ª visible → el cruce `count === THRESHOLD` se detecta EXACTAMENTE una vez.
      //    Conductores DISTINTOS NO se bloquean entre sí (clave de lock derivada del driverId). XACT-scoped: se
      //    libera SOLO al commit/rollback (no hay unlock manual que se pueda fugar). Namespace fijo
      //    `CANCELLATION_LOCK_NS` + hashtext(driverId) por la firma (int4,int4): aísla este lock de cualquier
      //    otro pg_advisory del schema. Una colisión de hashtext entre dos drivers solo causa contención benigna
      //    (uno espera de más), nunca incorrectitud.
      //    (Prisma serializa el number JS como int8; casteamos a int4 para casar la firma (int4,int4) —
      //    hashtext() ya devuelve int4. Sin el cast, Postgres no encuentra (bigint,integer) → 42883.)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CANCELLATION_LOCK_NS}::int4, hashtext(${driverId}))`;
      // 1) Registro idempotente SIN abortar la tx: createMany + skipDuplicates = ON CONFLICT DO NOTHING. El
      //    conflicto del @unique([driverId,tripId]) NO lanza (vs. create → P2002 → tx abortada 25P02). count
      //    devuelto = filas insertadas: 1 = cancelación nueva, 0 = re-entrega del mismo (driverId, tripId).
      const { count: inserted } = await tx.driverCancellationEvent.createMany({
        data: [{ driverId, tripId, occurredAt }],
        skipDuplicates: true,
      });
      // 2) EARLY-RETURN en re-entrega: la 1ª entrega ya hizo TODO (commiteado atómicamente con la fila). No
      //    re-cuenta, no re-emite, no infla el lifelong → NUNCA se alcanza el outbox → el dedupKey jamás colisiona.
      if (inserted === 0) return;
      // 3) Contador LIFELONG (tasa de cancelación del scoring, NUNCA se poda): solo en la PRIMERA entrega →
      //    idempotente por construcción (el early-return de arriba descarta las re-entregas). INCREMENTO ATÓMICO
      //    (`increment: 1`, no read-modify-write): cierra el lost-update aun fuera del advisory lock (defensa en
      //    profundidad) — dos tx concurrentes nunca leen N y escriben ambas N+1; el incremento se computa en la
      //    DB bajo el lock de fila implícito del UPDATE. Misma semántica: cada cancelación ÚNICA suma +1.
      await tx.driverStats.upsert({
        where: { driverId },
        create: { driverId, cancelledTrips: 1 },
        update: { cancelledTrips: { increment: 1 } },
      });
      // 4) Poda: las cancelaciones fuera de la ventana ya no cuentan (y mantienen la tabla acotada).
      await tx.driverCancellationEvent.deleteMany({
        where: { driverId, occurredAt: { lt: cutoff } },
      });
      // 5) Conteo de la ventana (occurredAt >= cutoff). La fila recién insertada está incluida.
      const count = await tx.driverCancellationEvent.count({
        where: { driverId, occurredAt: { gte: cutoff } },
      });
      // 6) Emisión SOLO en el cruce exacto (4→5): una sola emisión por cruce. count > threshold (cancelaciones
      //    sucesivas) NO re-emite. Como solo se llega acá en la PRIMERA entrega del tripId, el dedupKey (atado a
      //    ese tripId) NUNCA colisiona → el outboxEvent.create NO captura P2002 (no hay unique-violation que
      //    tragar dentro de la tx; si fallara por otro motivo, burbujea → rollback → Kafka re-procesa, sin perder
      //    la emisión porque la fila también se revirtió).
      if (count !== this.threshold) return;
      const envelope = createEnvelope({
        eventType: DRIVER_EXCESSIVE_CANCELLATIONS,
        producer: 'dispatch-service',
        // driverId = PERFIL en toda la cadena (igual que driver.flagged). count/windowStart/occurredAt para
        // trazabilidad del cruce. occurredAt del envelope = momento real de la cancelación que disparó el cruce.
        payload: {
          driverId,
          count,
          windowStart: cutoff.toISOString(),
          occurredAt: occurredAt.toISOString(),
        },
        // dedupKey DETERMINISTA por (driverId, tripId): el tripId que disparó el cruce identifica UNÍVOCAMENTE
        // este cruce. Sólo se inserta en la PRIMERA entrega (el early-return descarta las re-entregas), así que
        // el @unique(dedupKey) del outbox no se choca en el flujo normal — es defensa-en-profundidad downstream.
        dedupKey: `excessive_cancellations:${driverId}:${tripId}`,
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: driverId,
          eventType: envelope.eventType,
          dedupKey: envelope.dedupKey,
          envelope: envelope as unknown as Prisma.InputJsonValue,
        },
      });
      this.logger.warn(
        `Conductor ${driverId} cruzó el umbral de cancelaciones (${count} en ${this.windowMs / 3_600_000}h); emitido ${DRIVER_EXCESSIVE_CANCELLATIONS}`,
      );
    });
  }

  /** Lee stats de varios conductores y las normaliza para el scorer (con defaults para desconocidos). */
  async getStats(driverIds: string[]): Promise<Map<string, DriverScoreStats>> {
    const rows =
      driverIds.length === 0
        ? []
        : await this.prisma.read.driverStats.findMany({ where: { driverId: { in: driverIds } } });
    const now = Date.now();
    const map = new Map<string, DriverScoreStats>();
    for (const r of rows) {
      const completed = r.completedTrips;
      const cancelled = r.cancelledTrips;
      const total = completed + cancelled;
      map.set(r.driverId, {
        avgRating: Number(r.avgRating.toString()),
        secondsSinceLastTrip: r.lastTripAt
          ? Math.max(1, (now - r.lastTripAt.getTime()) / 1000)
          : NO_TRIP_SECONDS,
        cancellationRate: total > 0 ? cancelled / total : 0,
      });
    }
    for (const id of driverIds) {
      if (!map.has(id)) {
        map.set(id, {
          avgRating: DEFAULT_RATING,
          secondsSinceLastTrip: NO_TRIP_SECONDS,
          cancellationRate: 0,
        });
      }
    }
    return map;
  }
}
