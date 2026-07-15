/**
 * Puerto + adaptador Prisma de la tabla `CustomOffering` (ADR 013 · clean arch). Espeja el patrón del
 * PrismaOfferingCatalogRepository: el CatalogService depende de la INTERFAZ (CUSTOM_OFFERING_REPO), no de
 * Prisma — se testea con un repo en memoria; la persistencia vive en el adaptador.
 *
 * A diferencia del overlay (singleton), esta es una tabla de N filas. `findAll` alimenta la UNIÓN del catálogo
 * efectivo (built-in ∪ custom); `runInTx` cubre el ALTA (create + outbox `catalog.updated` en la MISMA tx, para
 * invalidar caches de consumidores igual que el PUT del overlay). `existsById` protege la unicidad del id generado.
 */
import { Injectable } from '@nestjs/common';
import type {
  CustomOfferingRecord,
  PricingMode,
  ServiceType,
  VehicleClass,
} from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';

/** Token DI del puerto (inyección por interfaz). */
export const CUSTOM_OFFERING_REPO = Symbol('CUSTOM_OFFERING_REPO');

/**
 * Cliente de transacción mínimo aceptado por el ALTA (create de la fila + outbox en la MISMA tx). Espeja
 * CatalogTx: el servicio depende de esta forma acotada, no del cliente Prisma entero.
 */
export interface CustomOfferingTx {
  customOffering: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string; createdAt: Date }>;
  };
  outboxEvent: {
    create(args: {
      data: { aggregateId: string; eventType: string; envelope: unknown };
    }): Promise<unknown>;
  };
}

/** Puerto: el servicio depende de esto, no de Prisma. */
export interface CustomOfferingRepository {
  /** Todas las ofertas custom (para unir al catálogo efectivo). Orden estable por creación. */
  findAll(): Promise<CustomOfferingRecord[]>;
  /** ¿Ya existe una fila con este id? (guard de unicidad del id generado, antes de crear). */
  existsById(id: string): Promise<boolean>;
  /** Abre una transacción de escritura (create de la fila + outbox `catalog.updated`). */
  runInTx<T>(fn: (tx: CustomOfferingTx) => Promise<T>): Promise<T>;
}

@Injectable()
export class PrismaCustomOfferingRepository implements CustomOfferingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<CustomOfferingRecord[]> {
    const rows = await this.prisma.read.customOffering.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toRecord);
  }

  async existsById(id: string): Promise<boolean> {
    const row = await this.prisma.read.customOffering.findUnique({
      where: { id },
      select: { id: true },
    });
    return row !== null;
  }

  async runInTx<T>(fn: (tx: CustomOfferingTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(async (tx) => fn(tx as unknown as CustomOfferingTx));
  }
}

/** Fila Prisma → CustomOfferingRecord (los enums viajan como string; el dominio los estrecha). */
function toRecord(row: {
  id: string;
  name: string;
  vehicleClass: string;
  serviceType: string;
  mode: string;
  multiplier: number;
  minFareCents: number;
  enabled: boolean;
}): CustomOfferingRecord {
  return {
    id: row.id,
    name: row.name,
    vehicleClass: row.vehicleClass as VehicleClass,
    serviceType: row.serviceType as ServiceType,
    mode: row.mode as PricingMode,
    multiplier: row.multiplier,
    minFareCents: row.minFareCents,
    enabled: row.enabled,
  };
}
