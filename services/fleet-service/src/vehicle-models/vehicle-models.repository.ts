/**
 * Puerto + adaptador Prisma del feature `vehicle-models/` (FOUNDATION §10: el repositorio es el ÚNICO dueño
 * de Prisma; ningún *.service.ts toca `this.prisma` directo). Espeja el molde de panic/media (token DI +
 * interfaz + adaptador, `runInTx`).
 *
 * Las lecturas de un solo statement (incluido el $queryRaw del fuzzy-match) son métodos del puerto, con la
 * query Prisma movida TAL CUAL adentro (el tagged-template se reconstruye idéntico → sigue 100% parametrizado
 * y no inyectable). Las DOS transacciones del feature (reopen · transition APROBAR/RECHAZAR) se abren con
 * `runInTx`: el CUERPO transaccional de dominio SIGUE en el service, que recibe el cliente tx tipado
 * `Prisma.TransactionClient` (el real) — el cuerpo combina el CAS (`updateMany`), el HEAL vía `$executeRaw`
 * (re-link de vehículos) y `outboxEvent.create` en la MISMA tx, sobre delegates completos.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import {
  Prisma,
  VehicleModelStatus,
  VehicleType,
  type VehicleModelSpec,
} from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const VEHICLE_MODELS_REPO = Symbol('VEHICLE_MODELS_REPO');

/** Fila cruda del $queryRaw del fuzzy-match: el id del mejor candidato + su score combinado. */
export interface FuzzyMatchRow {
  id: string;
  score: number;
}

/** Puerto: el VehicleModelsService depende de esto, NO de Prisma. */
export interface VehicleModelsRepository {
  /**
   * Abre una transacción de ESCRITURA y entrega el cliente tx al callback. El cuerpo (CAS + re-link + outbox
   * en la MISMA tx) vive en el service; aquí solo se abre/cierra la tx sobre el primario.
   */
  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;

  /**
   * FUZZY-MATCH (pg_trgm): mejor candidato APPROVED del `vehicleType` por similarity combinada (LEAST) sobre
   * las columnas normalizadas make_norm/model_norm. $queryRaw 100% PARAMETRIZADO (placeholders bindeados). Los
   * términos ya vienen normalizados por el service (espejo de las columnas generadas). Devuelve `[]` si nada.
   */
  fuzzyMatch(makeNorm: string, modelNorm: string, vehicleType: VehicleType): Promise<FuzzyMatchRow[]>;

  /** Modelo del catálogo por id, cualquier estado (read). `null` si no existe. */
  findById(id: string): Promise<VehicleModelSpec | null>;
  /** Modelo del catálogo APPROVED por id (read). `null` si no existe o no está aprobado. */
  findApprovedById(id: string): Promise<VehicleModelSpec | null>;
  /**
   * Dedup case-insensitive por natural key (make, model, yearFrom) (read). `null` si no existe — el unique
   * de DB es case-sensitive, este pre-check atrapa la variación de mayúsculas.
   */
  findByNaturalKey(make: string, model: string, yearFrom: number): Promise<VehicleModelSpec | null>;

  /** Página del catálogo APPROVED por keyset de id (read, `id asc`, `take`). Filtros vehicleType/q opcionales. */
  listApprovedPage(opts: {
    vehicleType?: VehicleType;
    q?: string;
    cursor?: string;
    take: number;
  }): Promise<VehicleModelSpec[]>;

  /** Página de la cola de revisión por estado y keyset de id (read, `id asc`, `take`). */
  listForReviewPage(opts: {
    status: VehicleModelStatus;
    cursor?: string;
    take: number;
  }): Promise<VehicleModelSpec[]>;

  /** Alta de una solicitud de modelo (write, PENDING_REVIEW). */
  create(data: Prisma.VehicleModelSpecCreateInput): Promise<VehicleModelSpec>;
}

@Injectable()
export class PrismaVehicleModelsRepository implements VehicleModelsRepository {
  constructor(private readonly prisma: PrismaService) {}

  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(fn);
  }

  fuzzyMatch(
    makeNorm: string,
    modelNorm: string,
    vehicleType: VehicleType,
  ): Promise<FuzzyMatchRow[]> {
    return this.prisma.read.$queryRaw<FuzzyMatchRow[]>`
      SELECT "id",
             LEAST(
               fleet.similarity("make_norm", ${makeNorm}),
               fleet.similarity("model_norm", ${modelNorm})
             ) AS score
      FROM "fleet"."vehicle_model_specs"
      WHERE "status" = ${VehicleModelStatus.APPROVED}::"fleet"."VehicleModelStatus"
        AND "vehicle_type" = ${vehicleType}::"fleet"."VehicleType"
      ORDER BY score DESC
      LIMIT 1
    `;
  }

  findById(id: string): Promise<VehicleModelSpec | null> {
    return this.prisma.read.vehicleModelSpec.findUnique({ where: { id } });
  }

  findApprovedById(id: string): Promise<VehicleModelSpec | null> {
    return this.prisma.read.vehicleModelSpec.findFirst({
      where: { id, status: VehicleModelStatus.APPROVED },
    });
  }

  findByNaturalKey(
    make: string,
    model: string,
    yearFrom: number,
  ): Promise<VehicleModelSpec | null> {
    return this.prisma.read.vehicleModelSpec.findFirst({
      where: {
        make: { equals: make, mode: 'insensitive' },
        model: { equals: model, mode: 'insensitive' },
        yearFrom,
      },
    });
  }

  listApprovedPage(opts: {
    vehicleType?: VehicleType;
    q?: string;
    cursor?: string;
    take: number;
  }): Promise<VehicleModelSpec[]> {
    const where: Prisma.VehicleModelSpecWhereInput = { status: VehicleModelStatus.APPROVED };
    if (opts.vehicleType) where.vehicleType = opts.vehicleType;
    if (opts.q) {
      const q = opts.q.trim();
      where.OR = [
        { make: { contains: q, mode: 'insensitive' } },
        { model: { contains: q, mode: 'insensitive' } },
      ];
    }
    if (opts.cursor) where.id = { gt: opts.cursor };
    return this.prisma.read.vehicleModelSpec.findMany({
      where,
      orderBy: { id: 'asc' },
      take: opts.take,
    });
  }

  listForReviewPage(opts: {
    status: VehicleModelStatus;
    cursor?: string;
    take: number;
  }): Promise<VehicleModelSpec[]> {
    const where: Prisma.VehicleModelSpecWhereInput = { status: opts.status };
    if (opts.cursor) where.id = { gt: opts.cursor };
    return this.prisma.read.vehicleModelSpec.findMany({
      where,
      orderBy: { id: 'asc' },
      take: opts.take,
    });
  }

  create(data: Prisma.VehicleModelSpecCreateInput): Promise<VehicleModelSpec> {
    return this.prisma.write.vehicleModelSpec.create({ data });
  }
}
