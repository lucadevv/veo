/**
 * Puerto + adaptador Prisma del feature `inspections/` (FOUNDATION §10: el repositorio es el ÚNICO dueño de
 * Prisma; ningún *.service.ts toca `this.prisma` directo). Espeja el molde de panic/media (token DI +
 * interfaz + adaptador, `runInTx`).
 *
 * Las lecturas de un solo statement son métodos del puerto (query Prisma movida TAL CUAL adentro). La
 * transacción de `create` se abre con `runInTx`: el CUERPO (`createInTx` — insert + posible auto-reactivación
 * por ITV vía `outboxEvent.create` en la MISMA tx, FOUNDATION §6) SIGUE en el service, que recibe el cliente
 * tx tipado `Prisma.TransactionClient` (el real). `createInTx` es tx-aware A PROPÓSITO: lo reusa
 * `documents.review()` para registrar la Inspección en la MISMA tx del CAS del documento ITV.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type Inspection, type Vehicle } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const INSPECTIONS_REPO = Symbol('INSPECTIONS_REPO');

/** Puerto: el InspectionsService depende de esto, NO de Prisma. */
export interface InspectionsRepository {
  /**
   * Abre una transacción de ESCRITURA y entrega el cliente tx al callback. El cuerpo (insert + auto-reactivación
   * en la MISMA tx) vive en el service; aquí solo se abre/cierra la tx sobre el primario.
   */
  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;

  /** Vehículo por id (read) — valida existencia antes de registrar la inspección. `null` si no existe. */
  findVehicleById(id: string): Promise<Vehicle | null>;

  /**
   * Inspección por natural key `[vehicleId, inspectedAt, inspectorId]` (read) — recuperación idempotente tras
   * un P2002 (re-POST / retry). `null` si no existe.
   */
  findByNaturalKey(
    vehicleId: string,
    inspectedAt: Date,
    inspectorId: string,
  ): Promise<Inspection | null>;

  /** Inspecciones de un vehículo (read, `inspectedAt desc`). */
  listByVehicle(vehicleId: string): Promise<Inspection[]>;

  /** Página admin de inspecciones por keyset de id (read, `id desc`, `take`). Filtro opcional por vehículo. */
  listPage(opts: { vehicleId?: string; cursor?: string; take: number }): Promise<Inspection[]>;
}

@Injectable()
export class PrismaInspectionsRepository implements InspectionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(fn);
  }

  findVehicleById(id: string): Promise<Vehicle | null> {
    return this.prisma.read.vehicle.findUnique({ where: { id } });
  }

  findByNaturalKey(
    vehicleId: string,
    inspectedAt: Date,
    inspectorId: string,
  ): Promise<Inspection | null> {
    return this.prisma.read.inspection.findUnique({
      where: {
        vehicleId_inspectedAt_inspectorId: { vehicleId, inspectedAt, inspectorId },
      },
    });
  }

  listByVehicle(vehicleId: string): Promise<Inspection[]> {
    return this.prisma.read.inspection.findMany({
      where: { vehicleId },
      orderBy: { inspectedAt: 'desc' },
    });
  }

  listPage(opts: { vehicleId?: string; cursor?: string; take: number }): Promise<Inspection[]> {
    const where: Prisma.InspectionWhereInput = {};
    if (opts.vehicleId) where.vehicleId = opts.vehicleId;
    if (opts.cursor) where.id = { lt: opts.cursor };
    return this.prisma.read.inspection.findMany({
      where,
      orderBy: { id: 'desc' },
      take: opts.take,
    });
  }
}
