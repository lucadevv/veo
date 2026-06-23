/**
 * ExpirySweeper (BR-I04) — cron diario que:
 *  1) recalcula `status` de cada documento con vencimiento (VALID / EXPIRING_SOON / EXPIRED),
 *  2) emite alertas en los hitos 30/15/7/1 días (una vez por hito),
 *  3) suspende al conductor (evento por outbox) si un documento crítico queda EXPIRED,
 *  4) recalcula el estado documental agregado del vehículo (SOAT + ITV + seguro).
 * Toda escritura va junto a su evento en la MISMA transacción (outbox, FOUNDATION §6).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../infra/prisma.service';
import { parseAlertMilestones } from '../config/env.schema';
import type { Env } from '../config/env.schema';
import {
  buildFleetEvent,
  FleetEventType,
  type DocumentExpiringPayload,
  type DocumentExpiredPayload,
  type DriverSuspendedPayload,
  type VehicleSuspendedPayload,
} from '../events/fleet-events';
import { recordFleetDomainEvent } from '../events/fleet-metrics';
import {
  computeExpiryAlert,
  daysUntilCeil,
  deriveExpiryStatus,
  isCriticalDocument,
} from '../documents/document-rules';
import {
  aggregateVehicleDocStatus,
  pickActiveVehicle,
  VEHICLE_REQUIRED_DOCUMENT_TYPES,
} from '../vehicles/vehicle-rules';
import { isInspectionCurrent } from '../inspections/inspection-rules';
import {
  FleetDocumentStatus,
  FleetOwnerType,
  Prisma,
  VehicleDocStatus,
  type FleetDocument,
} from '../generated/prisma';

export interface SweepSummary {
  documentsScanned: number;
  statusChanged: number;
  alertsEmitted: number;
  driversSuspended: number;
  vehiclesUpdated: number;
  /** Conductores suspendidos por ITV vencida del vehículo operado (pase independiente del documental). */
  driversSuspendedByInspection: number;
}

const PAGE_SIZE = 500;

@Injectable()
export class ExpirySweeper {
  private readonly logger = new Logger(ExpirySweeper.name);
  private readonly warningDays: number;
  private readonly milestones: number[];

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.warningDays = config.getOrThrow<number>('EXPIRY_WARNING_DAYS');
    this.milestones = parseAlertMilestones(config.getOrThrow<string>('EXPIRY_ALERT_MILESTONES'));
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async run(): Promise<void> {
    const summary = await this.sweep();
    this.logger.log(
      `Vencimientos: ${summary.documentsScanned} docs, ${summary.statusChanged} cambios, ` +
        `${summary.alertsEmitted} alertas, ${summary.driversSuspended} suspensiones, ` +
        `${summary.driversSuspendedByInspection} suspensiones por ITV, ` +
        `${summary.vehiclesUpdated} vehículos actualizados`,
    );
  }

  /** Ejecuta el barrido completo. Público para operación manual y pruebas de integración. */
  async sweep(now = new Date()): Promise<SweepSummary> {
    const summary: SweepSummary = {
      documentsScanned: 0,
      statusChanged: 0,
      alertsEmitted: 0,
      driversSuspended: 0,
      vehiclesUpdated: 0,
      driversSuspendedByInspection: 0,
    };

    let cursorId: string | undefined;
    for (;;) {
      const docs = await this.prisma.read.fleetDocument.findMany({
        where: {
          expiresAt: { not: null },
          status: {
            in: [
              FleetDocumentStatus.VALID,
              FleetDocumentStatus.EXPIRING_SOON,
              FleetDocumentStatus.EXPIRED,
            ],
          },
        },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
      });
      if (docs.length === 0) break;
      cursorId = docs[docs.length - 1]?.id;

      for (const doc of docs) {
        summary.documentsScanned += 1;
        await this.processDocument(doc, now, summary);
      }
      if (docs.length < PAGE_SIZE) break;
    }

    summary.vehiclesUpdated = await this.recomputeVehicles(now);
    summary.driversSuspendedByInspection = await this.suspendForExpiredInspections(now);
    return summary;
  }

  /**
   * AUTO-SUSPENSIÓN por INSPECCIÓN técnica (ITV) vencida (Lote B · compliance/seguridad). Cierra el lazo
   * del gate de aprobación (Lote A): si el vehículo OPERADO de un conductor pierde la ITV vigente, el
   * conductor se suspende. Es un pase INDEPENDIENTE del documental porque la ITV NO es un FleetDocument:
   * vive en el modelo `Inspection` (vehicle-scoped).
   *
   * CONSISTENCIA con el gate (NO se redefine la regla): se reusan `pickActiveVehicle` (selector
   * AUTORITATIVO ÚNICO del vehículo operado) e `isInspectionCurrent` (vigencia = última `passed &&
   * nextDueAt > now`). Lo que el gate de aprobación BLOQUEA al aprobar es exactamente lo que acá SUSPENDE
   * a un conductor ya aprobado: la última inspección reprobada (`passed=false`, perdió la ITV) o vencida
   * (`nextDueAt <= now`) deja de ser vigente → suspensión.
   *
   * GRANDFATHER: un conductor cuyo vehículo operado NO tiene NINGUNA inspección en archivo NO se toca —
   * no hay vencimiento que procesar (la suspensión nace de PERDER una ITV vigente, no de nunca haberla
   * tenido; ese hueco lo cubre el gate de aprobación de alta).
   *
   * RESOLUCIÓN DE ID (el filo de este lote): se suspende keyando el evento por `userId` = `Vehicle.driverId`
   * (que ES el User.id, NO el id de perfil Driver). fleet NO traduce a id de perfil — identity lo resuelve
   * en su consumer (dueño del mapeo User.id → Driver.id). Mandar el User.id en `driverId` suspendería al
   * conductor EQUIVOCADO.
   *
   * IDEMPOTENCIA (modelo de HOLDS, sin latch local): el sweeper re-evalúa TODOS los vehículos con conductor
   * en cada corrida y RE-EMITE `fleet.driver_suspended` si la ITV sigue vencida — NO hay un latch
   * `inspectionSuspendedAt` que filtre/deduplique en fleet. La idempotencia la garantiza identity: el hold
   * INSPECTION_EXPIRED tiene `@@unique([driverId, cause, causeRef])`, así que re-recibir el evento de una causa
   * ya-tenida es un upsert NO-OP (no reescribe el momento ni re-suspende). Volumen aceptable: el cron es DIARIO
   * → como mucho 1 evento/día por conductor con ITV vencida, idempotente en identity. El `Set` evita re-evaluar
   * al MISMO conductor dos veces DENTRO de una corrida (cuando tiene N vehículos en páginas distintas).
   */
  private async suspendForExpiredInspections(now: Date): Promise<number> {
    let suspended = 0;
    let cursorId: string | undefined;
    // Conductores ya evaluados en ESTA corrida (dedupe cross-página): el cursor pagina por `id` de vehículo
    // (único), pero el sujeto es el CONDUCTOR (driverId = User.id) y un conductor puede tener N vehículos en
    // páginas distintas. El Set lo evalúa UNA sola vez (el gate mira su vehículo OPERADO, no cada vehículo).
    const seen = new Set<string>();
    for (;;) {
      // Vehículos con conductor (driverId = User.id). SIN filtro de latch: el sweeper re-evalúa todo en cada
      // corrida y re-emite si la ITV sigue vencida; identity dedup-ea por el unique del hold. El Set evita
      // re-evaluar al mismo conductor dentro de la corrida.
      const vehicles = await this.prisma.read.vehicle.findMany({
        where: { driverId: { not: null } },
        select: { id: true, driverId: true },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
      });
      if (vehicles.length === 0) break;
      cursorId = vehicles[vehicles.length - 1]?.id;

      // FIX N+1 (batch · espeja recomputeVehicles): los conductores NUEVOS de esta página se evalúan en
      // LOTE — UNA query de TODOS sus vehículos (para resolver el operado con pickActiveVehicle) + UNA query
      // de inspecciones del lote de vehículos operados — en vez de 2 queries POR conductor. La SEMÁNTICA es
      // idéntica (mismo pickActiveVehicle + isInspectionCurrent + grandfather); solo cambia el acceso a datos.
      const userIds = [...new Set(vehicles.map((v) => v.driverId).filter((id): id is string => !!id))]
        .filter((id) => !seen.has(id));
      for (const id of userIds) seen.add(id);
      suspended += await this.suspendBatchByInspection(userIds, now);
      if (vehicles.length < PAGE_SIZE) break;
    }
    return suspended;
  }

  /**
   * Evalúa un LOTE de conductores (por su User.id = Vehicle.driverId) con acceso a datos batcheado
   * (FIX N+1 · mismo patrón que recomputeVehicles): resuelve el vehículo OPERADO de cada uno con el MISMO
   * `pickActiveVehicle` del gate, carga la ÚLTIMA inspección de TODOS los vehículos operados en UNA query, y
   * suspende a los conductores cuya última ITV NO es vigente (`isInspectionCurrent` false: reprobada o
   * vencida). Grandfather: sin inspección en archivo → no se suspende (distinguimos "perdió la ITV" de
   * "nunca la tuvo"; ese hueco lo cubre el gate de alta). La regla de vigencia es la MISMA del gate (no se
   * redefine), solo cambió de N+1 a batch. @returns cuántos conductores se suspendieron.
   */
  private async suspendBatchByInspection(userIds: string[], now: Date): Promise<number> {
    if (userIds.length === 0) return 0;

    // UNA query: TODOS los vehículos de TODOS los conductores del lote (incluye EXPIRED — pickActiveVehicle
    // los filtra). Se agrupan en memoria por conductor para elegir el operado de cada uno.
    const allVehicles = await this.prisma.read.vehicle.findMany({
      where: { driverId: { in: userIds } },
    });
    const vehiclesByUser = new Map<string, typeof allVehicles>();
    for (const v of allVehicles) {
      if (!v.driverId) continue;
      const arr = vehiclesByUser.get(v.driverId) ?? [];
      arr.push(v);
      vehiclesByUser.set(v.driverId, arr);
    }

    // Resuelve el vehículo OPERADO de cada conductor (pickActiveVehicle, server-authoritative). Map
    // vehicleId-operado → userId, para luego asociar la inspección de cada vehículo a su conductor.
    const activeByUser = new Map<string, (typeof allVehicles)[number]>();
    const userByActiveVehicle = new Map<string, string>();
    for (const userId of userIds) {
      const active = pickActiveVehicle(vehiclesByUser.get(userId) ?? []);
      if (!active) continue; // sin vehículo operable: nada que evaluar (lo cubre el gate de alta).
      activeByUser.set(userId, active);
      userByActiveVehicle.set(active.id, userId);
    }
    if (userByActiveVehicle.size === 0) return 0;

    // UNA query: las inspecciones de TODOS los vehículos operados del lote, ordenadas por `inspectedAt desc`
    // (mismo orderBy del gate). En memoria nos quedamos con la PRIMERA (la última) por vehículo → equivale al
    // `findFirst` per-vehículo, en una sola ida a la DB.
    const inspections = await this.prisma.read.inspection.findMany({
      where: { vehicleId: { in: [...userByActiveVehicle.keys()] } },
      orderBy: { inspectedAt: 'desc' },
    });
    const latestByVehicle = new Map<string, (typeof inspections)[number]>();
    for (const insp of inspections) {
      if (!latestByVehicle.has(insp.vehicleId)) latestByVehicle.set(insp.vehicleId, insp);
    }

    let suspended = 0;
    for (const userId of userIds) {
      const active = activeByUser.get(userId);
      if (!active) continue;
      const latest = latestByVehicle.get(active.id);
      // GRANDFATHER: sin inspección en archivo → no hay ITV que pueda VENCER. No se suspende.
      if (!latest) continue;
      // Vigente (última passed && nextDueAt > now) → no se toca. Regla idéntica al gate (no se redefine).
      if (isInspectionCurrent(latest, now)) continue;
      await this.suspendByInspection(userId, active.id, latest, now);
      suspended += 1;
    }
    return suspended;
  }

  /**
   * EMISIÓN de la suspensión por ITV vencida de UN conductor. Aislado en su propia tx (el evento va por
   * outbox, FOUNDATION §6). SIN latch local: ya no hay CAS sobre `inspectionSuspendedAt` — el sweeper
   * re-emite en cada corrida y la idempotencia la garantiza identity con el `@@unique` del hold
   * INSPECTION_EXPIRED (re-recibir la misma causa = upsert NO-OP, no re-suspende ni mueve el momento).
   */
  private async suspendByInspection(
    userId: string,
    vehicleId: string,
    latest: { id: string; nextDueAt: Date },
    now: Date,
  ): Promise<void> {
    return this.prisma.write.$transaction(async (tx) => {
      const suspendPayload: DriverSuspendedPayload = {
        // KEYEADO POR userId (User.id = Vehicle.driverId), NO driverId de perfil: identity resuelve el mapeo.
        userId,
        reason: 'Inspección técnica (ITV) vencida',
        vehicleId,
        inspectionId: latest.id,
        nextDueAt: latest.nextDueAt.toISOString(),
        suspendedAt: now.toISOString(),
      };
      await this.enqueue(
        tx,
        userId,
        buildFleetEvent(FleetEventType.DRIVER_SUSPENDED, suspendPayload),
      );
    });
  }

  private async processDocument(
    doc: FleetDocument,
    now: Date,
    summary: SweepSummary,
  ): Promise<void> {
    const newStatus = deriveExpiryStatus(doc.expiresAt, now, this.warningDays);
    const statusChanged = newStatus !== doc.status;
    const milestone = computeExpiryAlert({
      expiresAt: doc.expiresAt,
      now,
      milestones: this.milestones,
      alreadyAlertedDays: doc.lastAlertedDays,
    });

    // RE-ASSERCIÓN DE SUSPENSIÓN POR DOCUMENTO (latch-free, espeja la ITV): un documento CRÍTICO DRIVER-scoped
    // que está EXPIRED debe RE-EMITIR `fleet.driver_suspended` en CADA corrida, no solo en la transición
    // VALID→EXPIRED. Por qué: si la suspensión de la transición se PIERDE (ej. el conductor aún no estaba
    // onboardeado → identity `suspendByFleet` es no-op silencioso; el evento se consumió sin efecto), con el
    // modelo solo-en-transición NUNCA se re-emitía → el conductor quedaba SIN suspender pese al doc vencido
    // (asimetría con la ITV, que sí re-asserta). Idempotente aguas abajo: identity dedup-ea por el
    // `@@unique([driverId, DOCUMENT_EXPIRED, docType])` del hold. Volumen aceptable: cron DIARIO.
    const reassertSuspension =
      newStatus === FleetDocumentStatus.EXPIRED &&
      doc.ownerType === FleetOwnerType.DRIVER &&
      isCriticalDocument(doc.type) &&
      doc.expiresAt !== null;

    // Sin trabajo que hacer: nada cambió, no hay hito Y no hay suspensión que re-assertar → salir.
    if (!statusChanged && milestone === null && !reassertSuspension) return;

    await this.prisma.write.$transaction(async (tx) => {
      const data: Prisma.FleetDocumentUpdateInput = {};
      if (statusChanged) data.status = newStatus;
      if (milestone !== null) data.lastAlertedDays = milestone;
      // Solo escribir si hay algo que persistir (la re-asserción pura no muta el documento).
      if (statusChanged || milestone !== null) {
        await tx.fleetDocument.update({ where: { id: doc.id }, data });
      }

      if (milestone !== null && doc.expiresAt) {
        const payload: DocumentExpiringPayload = {
          documentId: doc.id,
          ownerType: doc.ownerType,
          ownerId: doc.ownerId,
          documentType: doc.type,
          expiresAt: doc.expiresAt.toISOString(),
          daysRemaining: daysUntilCeil(doc.expiresAt, now),
          milestone,
        };
        await this.enqueue(tx, doc.id, buildFleetEvent(FleetEventType.DOCUMENT_EXPIRING, payload));
        summary.alertsEmitted += 1;
      }

      // `DOCUMENT_EXPIRED` es la NOTIFICACIÓN one-shot de "el documento ACABA de vencer": SOLO en la transición
      // (identity NO dedup-ea este evento; re-emitirlo cada corrida spamearía a los consumidores).
      if (statusChanged && newStatus === FleetDocumentStatus.EXPIRED && doc.expiresAt) {
        const expiredPayload: DocumentExpiredPayload = {
          documentId: doc.id,
          ownerType: doc.ownerType,
          ownerId: doc.ownerId,
          documentType: doc.type,
          expiresAt: doc.expiresAt.toISOString(),
          critical: isCriticalDocument(doc.type),
        };
        await this.enqueue(
          tx,
          doc.id,
          buildFleetEvent(FleetEventType.DOCUMENT_EXPIRED, expiredPayload),
        );
      }

      // La SUSPENSIÓN del conductor, en cambio, se RE-ASSERTA cada corrida (latch-free, como la ITV):
      // mientras el doc crítico siga EXPIRED, re-emitimos `fleet.driver_suspended` (idempotente en identity por
      // el hold). NO depende de `statusChanged` — cubre el caso de la suspensión perdida en la transición.
      if (reassertSuspension && doc.expiresAt) {
        const suspendPayload: DriverSuspendedPayload = {
          driverId: doc.ownerId,
          reason: `Documento crítico vencido (${doc.type})`,
          documentId: doc.id,
          documentType: doc.type,
          // `suspendedAt` = `now` (coherente con cómo lo emite el pase de ITV, suspendByInspection). identity
          // PRESERVA el createdAt del hold ante la re-recepción idempotente (upsert update vacío), así que la
          // re-asserción diaria NO "rejuvenece" el momento original de la suspensión aguas abajo.
          suspendedAt: now.toISOString(),
        };
        await this.enqueue(
          tx,
          doc.ownerId,
          buildFleetEvent(FleetEventType.DRIVER_SUSPENDED, suspendPayload),
        );
        summary.driversSuspended += 1;
      }
      if (statusChanged) summary.statusChanged += 1;
    });
  }

  /** Recalcula docStatus de cada vehículo a partir de SOAT/ITV + seguro. Emite vehicle.suspended al caer en EXPIRED. */
  private async recomputeVehicles(now: Date): Promise<number> {
    let updated = 0;
    let cursorId: string | undefined;
    for (;;) {
      const vehicles = await this.prisma.read.vehicle.findMany({
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
      });
      if (vehicles.length === 0) break;
      cursorId = vehicles[vehicles.length - 1]?.id;

      const vehicleIds = vehicles.map((v) => v.id);
      const docsByVehicle = new Map<string, ('VALID' | 'EXPIRING_SOON' | 'EXPIRED')[]>();
      const allDocs = await this.prisma.read.fleetDocument.findMany({
        where: {
          ownerType: FleetOwnerType.VEHICLE,
          ownerId: { in: vehicleIds },
          type: { in: [...VEHICLE_REQUIRED_DOCUMENT_TYPES] },
          status: {
            in: [
              FleetDocumentStatus.VALID,
              FleetDocumentStatus.EXPIRING_SOON,
              FleetDocumentStatus.EXPIRED,
            ],
          },
        },
        select: { ownerId: true, status: true },
      });
      for (const d of allDocs) {
        const arr = docsByVehicle.get(d.ownerId) ?? [];
        arr.push(d.status as 'VALID' | 'EXPIRING_SOON' | 'EXPIRED');
        docsByVehicle.set(d.ownerId, arr);
      }

      for (const vehicle of vehicles) {
        const statuses = [...(docsByVehicle.get(vehicle.id) ?? [])];
        statuses.push(deriveExpiryStatus(vehicle.insuranceExpiresAt, now, this.warningDays));
        const newDocStatus = aggregateVehicleDocStatus(statuses);

        if (newDocStatus === vehicle.docStatus) continue;
        await this.prisma.write.$transaction(async (tx) => {
          await tx.vehicle.update({ where: { id: vehicle.id }, data: { docStatus: newDocStatus } });
          if (newDocStatus === VehicleDocStatus.EXPIRED) {
            const payload: VehicleSuspendedPayload = {
              vehicleId: vehicle.id,
              reason: 'Documentación del vehículo vencida (SOAT/ITV/seguro)',
              suspendedAt: now.toISOString(),
            };
            await this.enqueue(
              tx,
              vehicle.id,
              buildFleetEvent(FleetEventType.VEHICLE_SUSPENDED, payload),
            );
          }
        });
        updated += 1;
      }
      if (vehicles.length < PAGE_SIZE) break;
    }
    return updated;
  }

  private async enqueue(
    tx: Prisma.TransactionClient,
    aggregateId: string,
    envelope: ReturnType<typeof buildFleetEvent>,
  ): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        aggregateId,
        eventType: envelope.eventType,
        envelope: envelope as unknown as Prisma.InputJsonValue,
      },
    });
    // OBSERVABILIDAD (FOUNDATION §5/§6, CLAUDE.md regla 6): el sweeper emite 4+ tipos de evento de dominio
    // y solo logueaba el resumen. Bumpeamos el counter ESTÁNDAR `domain_events_total{event,result}` en el
    // punto ÚNICO por donde pasan TODOS los eventos del sweeper (este enqueue) → una sola línea cubre
    // document_expiring/expired, driver_suspended/reactivated y vehicle_suspended. El eventType viaja tipado.
    recordFleetDomainEvent(envelope.eventType as FleetEventType);
  }
}
