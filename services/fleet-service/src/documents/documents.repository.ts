/**
 * Puerto + adaptador Prisma del feature `documents/` (FOUNDATION §10: el repositorio es el ÚNICO dueño de
 * Prisma; ningún *.service.ts toca `this.prisma` directo). Espeja el molde de panic/media (token DI +
 * interfaz + adaptador, cliente dual read/write, `runInTx`).
 *
 * Las lecturas de un solo statement son métodos del puerto (con la query Prisma movida TAL CUAL adentro).
 * Las TRES transacciones del feature (create · replaceActiveDocument · review) se abren con `runInTx`: el
 * CUERPO transaccional de dominio SIGUE viviendo en el service, que recibe el cliente de transacción tipado
 * `Prisma.TransactionClient` (el real) — los cuerpos combinan mutaciones sobre `fleetDocument`/`documentImage`
 * con `outboxEvent.create`, la Inspección auto-registrada (`inspections.createInTx`) y lecturas tx-consistentes,
 * todo sobre delegates completos; un puerto estrecho re-implementaría a mano los tipos de Prisma sin ganancia.
 *
 * El predicado de dominio de `listExpirations` (base + keyset compuesto) es LÓGICA del service: el repo recibe
 * el `where` ya construido y solo posee el acceso Prisma (orderBy/take/findMany), como en list().
 */
import { Injectable } from '@nestjs/common';
import { FleetDocumentType } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import {
  FleetDocumentStatus,
  FleetOwnerType,
  Prisma,
  type DocumentImage,
  type FleetDocument,
  type Vehicle,
} from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const DOCUMENTS_REPO = Symbol('DOCUMENTS_REPO');

/** Documento con sus imágenes (orden estable) — lo que devuelven las lecturas con `include`. */
export type FleetDocumentWithImages = FleetDocument & { images: DocumentImage[] };

/** Puerto: el DocumentsService depende de esto, NO de Prisma. */
export interface DocumentsRepository {
  /**
   * Abre una transacción de ESCRITURA y entrega el cliente tx al callback. El cuerpo (mutaciones + outbox +
   * inspección auto-registrada en la MISMA tx) vive en el service; aquí solo se abre/cierra la tx sobre el primario.
   */
  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;

  /** Vehículo por id (read) — validación de existencia/pertenencia del owner VEHICLE. `null` si no existe. */
  findVehicleById(id: string): Promise<Vehicle | null>;

  /**
   * Documento activo (PENDING_REVIEW/VALID/EXPIRING_SOON) del mismo owner+type desde el PRIMARIO (write):
   * read-your-writes del chequeo de duplicado (un doc recién creado puede no haberse replicado aún). `null`
   * si no hay activo.
   */
  findActiveDocumentOnPrimary(
    ownerType: FleetOwnerType,
    ownerId: string,
    type: FleetDocumentType,
  ): Promise<FleetDocument | null>;

  /** Documentos de un owner con sus imágenes (read, `createdAt desc`). */
  listByOwner(ownerId: string): Promise<FleetDocumentWithImages[]>;

  /** Página admin de documentos por keyset de id (read, `id desc`, `take`). Filtros opcionales owner/status. */
  listPage(opts: {
    ownerId?: string;
    status?: FleetDocumentStatus;
    cursor?: string;
    take: number;
  }): Promise<FleetDocument[]>;

  /**
   * Página de vencimientos por keyset compuesto (read, `expiresAt asc, id asc`, `take`). El `where` (base +
   * predicado keyset) lo construye el service (lógica de dominio); el repo solo posee el acceso Prisma.
   */
  findExpirationsPage(
    where: Prisma.FleetDocumentWhereInput,
    take: number,
  ): Promise<FleetDocument[]>;
}

@Injectable()
export class PrismaDocumentsRepository implements DocumentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(fn);
  }

  findVehicleById(id: string): Promise<Vehicle | null> {
    return this.prisma.read.vehicle.findUnique({ where: { id } });
  }

  findActiveDocumentOnPrimary(
    ownerType: FleetOwnerType,
    ownerId: string,
    type: FleetDocumentType,
  ): Promise<FleetDocument | null> {
    return this.prisma.write.fleetDocument.findFirst({
      where: {
        ownerType,
        ownerId,
        type,
        status: {
          in: [
            FleetDocumentStatus.PENDING_REVIEW,
            FleetDocumentStatus.VALID,
            FleetDocumentStatus.EXPIRING_SOON,
          ],
        },
      },
    });
  }

  listByOwner(ownerId: string): Promise<FleetDocumentWithImages[]> {
    return this.prisma.read.fleetDocument.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      include: { images: { orderBy: { order: 'asc' } } },
    });
  }

  listPage(opts: {
    ownerId?: string;
    status?: FleetDocumentStatus;
    cursor?: string;
    take: number;
  }): Promise<FleetDocument[]> {
    const where: Prisma.FleetDocumentWhereInput = {};
    if (opts.ownerId) where.ownerId = opts.ownerId;
    if (opts.status) where.status = opts.status;
    if (opts.cursor) where.id = { lt: opts.cursor };
    return this.prisma.read.fleetDocument.findMany({
      where,
      orderBy: { id: 'desc' },
      take: opts.take,
    });
  }

  findExpirationsPage(
    where: Prisma.FleetDocumentWhereInput,
    take: number,
  ): Promise<FleetDocument[]> {
    return this.prisma.read.fleetDocument.findMany({
      where,
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take,
    });
  }
}
