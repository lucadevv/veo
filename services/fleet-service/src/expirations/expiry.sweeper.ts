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
import {
  computeExpiryAlert,
  daysUntilCeil,
  deriveExpiryStatus,
  isCriticalDocument,
} from '../documents/document-rules';
import { aggregateVehicleDocStatus, VEHICLE_REQUIRED_DOCUMENT_TYPES } from '../vehicles/vehicle-rules';
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
    };

    let cursorId: string | undefined;
    for (;;) {
      const docs = await this.prisma.read.fleetDocument.findMany({
        where: {
          expiresAt: { not: null },
          status: {
            in: [FleetDocumentStatus.VALID, FleetDocumentStatus.EXPIRING_SOON, FleetDocumentStatus.EXPIRED],
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
    return summary;
  }

  private async processDocument(doc: FleetDocument, now: Date, summary: SweepSummary): Promise<void> {
    const newStatus = deriveExpiryStatus(doc.expiresAt, now, this.warningDays);
    const statusChanged = newStatus !== doc.status;
    const milestone = computeExpiryAlert({
      expiresAt: doc.expiresAt,
      now,
      milestones: this.milestones,
      alreadyAlertedDays: doc.lastAlertedDays,
    });

    if (!statusChanged && milestone === null) return;

    await this.prisma.write.$transaction(async (tx) => {
      const data: Prisma.FleetDocumentUpdateInput = {};
      if (statusChanged) data.status = newStatus;
      if (milestone !== null) data.lastAlertedDays = milestone;
      await tx.fleetDocument.update({ where: { id: doc.id }, data });

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

      if (statusChanged && newStatus === FleetDocumentStatus.EXPIRED && doc.expiresAt) {
        const critical = isCriticalDocument(doc.type);
        const expiredPayload: DocumentExpiredPayload = {
          documentId: doc.id,
          ownerType: doc.ownerType,
          ownerId: doc.ownerId,
          documentType: doc.type,
          expiresAt: doc.expiresAt.toISOString(),
          critical,
        };
        await this.enqueue(tx, doc.id, buildFleetEvent(FleetEventType.DOCUMENT_EXPIRED, expiredPayload));

        if (critical && doc.ownerType === FleetOwnerType.DRIVER) {
          const suspendPayload: DriverSuspendedPayload = {
            driverId: doc.ownerId,
            reason: `Documento crítico vencido (${doc.type})`,
            documentId: doc.id,
            documentType: doc.type,
            suspendedAt: now.toISOString(),
          };
          await this.enqueue(tx, doc.ownerId, buildFleetEvent(FleetEventType.DRIVER_SUSPENDED, suspendPayload));
          summary.driversSuspended += 1;
        }
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

      for (const vehicle of vehicles) {
        const docs = await this.prisma.read.fleetDocument.findMany({
          where: {
            ownerType: FleetOwnerType.VEHICLE,
            ownerId: vehicle.id,
            type: { in: [...VEHICLE_REQUIRED_DOCUMENT_TYPES] },
            status: {
              in: [FleetDocumentStatus.VALID, FleetDocumentStatus.EXPIRING_SOON, FleetDocumentStatus.EXPIRED],
            },
          },
          select: { status: true },
        });
        const statuses = docs.map((d) => d.status as 'VALID' | 'EXPIRING_SOON' | 'EXPIRED');
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
            await this.enqueue(tx, vehicle.id, buildFleetEvent(FleetEventType.VEHICLE_SUSPENDED, payload));
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
  }
}
