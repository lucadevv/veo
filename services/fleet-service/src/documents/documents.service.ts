/**
 * DocumentsService — alta, revisión manual (RBAC) y consulta de documentos de flota (BR-I04).
 * El recálculo masivo por vencimiento y las alertas/suspensión los ejecuta ExpirySweeper (cron).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { uuidv7, NotFoundError, ConflictError, ValidationError } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { clampLimit, toPage, type Page } from '../infra/pagination';
import { buildFleetEvent, FleetEventType } from '../events/fleet-events';
import { deriveExpiryStatus, isCriticalDocument } from './document-rules';
import { ReviewDecision } from './dto/document.dto';
import type { CreateDocumentDto } from './dto/document.dto';
import {
  FleetDocumentStatus,
  FleetOwnerType,
  Prisma,
  type FleetDocument,
} from '../generated/prisma';
import type { Env } from '../config/env.schema';

@Injectable()
export class DocumentsService {
  private readonly warningDays: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.warningDays = config.getOrThrow<number>('EXPIRY_WARNING_DAYS');
  }

  /** Sube un documento. Entra como PENDING_REVIEW hasta que el operador lo valide (BR-I04). */
  async create(input: CreateDocumentDto): Promise<FleetDocument> {
    if (input.ownerType === FleetOwnerType.VEHICLE) {
      const vehicle = await this.prisma.read.vehicle.findUnique({ where: { id: input.ownerId } });
      if (!vehicle)
        throw new NotFoundError('Vehículo dueño del documento no existe', {
          ownerId: input.ownerId,
        });
    }

    const duplicate = await this.prisma.read.fleetDocument.findFirst({
      where: {
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        type: input.type,
        status: {
          in: [
            FleetDocumentStatus.PENDING_REVIEW,
            FleetDocumentStatus.VALID,
            FleetDocumentStatus.EXPIRING_SOON,
          ],
        },
      },
    });
    if (duplicate) {
      throw new ConflictError('Ya existe un documento activo de ese tipo para el dueño', {
        ownerId: input.ownerId,
        type: input.type,
      });
    }

    return this.prisma.write.fleetDocument.create({
      data: {
        id: uuidv7(),
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        type: input.type,
        documentNumber: input.documentNumber.trim(),
        issuedAt: input.issuedAt ? new Date(input.issuedAt) : null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        fileS3Key: input.fileS3Key ?? null,
        status: FleetDocumentStatus.PENDING_REVIEW,
      },
    });
  }

  listByOwner(ownerId: string): Promise<FleetDocument[]> {
    return this.prisma.read.fleetDocument.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Lista paginada de documentos para el operador (admin), filtrable por estado (índice
   * `[status, expiresAt]`). Paginación cursor por id (uuidv7). Sin `status` lista todos.
   */
  async list(opts: {
    ownerId?: string;
    status?: FleetDocumentStatus;
    cursor?: string;
    limit?: number;
  }): Promise<Page<FleetDocument>> {
    const limit = clampLimit(opts.limit);
    const where: Prisma.FleetDocumentWhereInput = {};
    if (opts.ownerId) where.ownerId = opts.ownerId;
    if (opts.status) where.status = opts.status;
    if (opts.cursor) where.id = { lt: opts.cursor };
    const rows = await this.prisma.read.fleetDocument.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    return toPage(rows, limit);
  }

  /**
   * Revisión manual del operador (RBAC). REJECTED queda rechazado; VALID recalcula su estado
   * por vencimiento de inmediato (puede caer en EXPIRING_SOON/EXPIRED). Si un documento crítico de
   * un conductor queda EXPIRED, se publica la suspensión por outbox (BR-I04).
   */
  async review(
    id: string,
    decision: ReviewDecision,
    reviewerId: string,
    now = new Date(),
  ): Promise<FleetDocument> {
    const doc = await this.prisma.read.fleetDocument.findUnique({ where: { id } });
    if (!doc) throw new NotFoundError('Documento no encontrado', { id });
    if (doc.status !== FleetDocumentStatus.PENDING_REVIEW) {
      throw new ValidationError('El documento no está pendiente de revisión', {
        status: doc.status,
      });
    }

    const finalStatus =
      decision === ReviewDecision.REJECTED
        ? FleetDocumentStatus.REJECTED
        : deriveExpiryStatus(doc.expiresAt, now, this.warningDays);

    return this.prisma.write.$transaction(async (tx) => {
      const updated = await tx.fleetDocument.update({
        where: { id },
        data: { status: finalStatus, verifiedAt: now, verifiedBy: reviewerId },
      });

      if (finalStatus === FleetDocumentStatus.EXPIRED) {
        const critical = isCriticalDocument(updated.type);
        await this.enqueue(
          tx,
          updated.id,
          buildFleetEvent(FleetEventType.DOCUMENT_EXPIRED, {
            documentId: updated.id,
            ownerType: updated.ownerType,
            ownerId: updated.ownerId,
            documentType: updated.type,
            expiresAt: (updated.expiresAt ?? now).toISOString(),
            critical,
          }),
        );
        if (critical && updated.ownerType === FleetOwnerType.DRIVER) {
          await this.enqueue(
            tx,
            updated.ownerId,
            buildFleetEvent(FleetEventType.DRIVER_SUSPENDED, {
              driverId: updated.ownerId,
              reason: `Documento crítico vencido (${updated.type})`,
              documentId: updated.id,
              documentType: updated.type,
              suspendedAt: now.toISOString(),
            }),
          );
        }
      }
      return updated;
    });
  }

  /** Documentos por vencer o vencidos, ordenados por proximidad de vencimiento. */
  listExpirations(withinDays?: number, now = new Date()): Promise<FleetDocument[]> {
    const where: Prisma.FleetDocumentWhereInput =
      withinDays !== undefined
        ? {
            expiresAt: { not: null, lte: new Date(now.getTime() + withinDays * 86_400_000) },
            status: {
              in: [
                FleetDocumentStatus.VALID,
                FleetDocumentStatus.EXPIRING_SOON,
                FleetDocumentStatus.EXPIRED,
              ],
            },
          }
        : { status: { in: [FleetDocumentStatus.EXPIRING_SOON, FleetDocumentStatus.EXPIRED] } };

    return this.prisma.read.fleetDocument.findMany({ where, orderBy: { expiresAt: 'asc' } });
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
