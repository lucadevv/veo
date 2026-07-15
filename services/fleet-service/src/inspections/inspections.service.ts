/**
 * InspectionsService — registra inspecciones técnicas y calcula su próximo vencimiento (BR-D04).
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { uuidv7, NotFoundError } from '@veo/utils';
import { isUniqueViolation } from '@veo/database';
import { INSPECTIONS_REPO, type InspectionsRepository } from './inspections.repository';
import { clampLimit, toPage, type Page } from '../infra/pagination';
import {
  computeNextInspectionDue,
  assertInspectedAtNotFuture,
  isInspectionCurrent,
} from './inspection-rules';
import {
  buildFleetEvent,
  FleetEventType,
  type DriverReactivatedPayload,
} from '../events/fleet-events';
import type { CreateInspectionDto } from './dto/inspection.dto';
import { Prisma, type Inspection } from '../generated/prisma';
import type { Env } from '../config/env.schema';

@Injectable()
export class InspectionsService {
  private readonly intervalMonths: number;

  constructor(
    @Inject(INSPECTIONS_REPO) private readonly repo: InspectionsRepository,
    config: ConfigService<Env, true>,
  ) {
    this.intervalMonths = config.getOrThrow<number>('INSPECTION_INTERVAL_MONTHS');
  }

  // RESIDUAL (decisión de producto · dueño): NO hay separación-de-deberes plena — hoy el MISMO set de
  // roles que APRUEBA al conductor (COMPLIANCE_SUPERVISOR/ADMIN/SUPERADMIN) puede REGISTRAR la ITV. El
  // anti-futuro (abajo) + la auditoría del registro (admin-bff FleetService.createInspection) cierran lo
  // no-controversial; exigir que el actor que registra la ITV sea DISTINTO del que aprueba queda pendiente
  // del dueño (cambio de modelo de roles), NO se implementa acá.
  async create(input: CreateInspectionDto, inspectorId: string): Promise<Inspection> {
    const vehicle = await this.repo.findVehicleById(input.vehicleId);
    if (!vehicle) throw new NotFoundError('Vehículo no encontrado', { vehicleId: input.vehicleId });

    const now = new Date();
    const inspectedAt = input.inspectedAt ? new Date(input.inspectedAt) : now;
    // ANTI-FUTURO (compliance): una inspección NO puede ser del futuro. Sin este tope, un `inspectedAt`
    // fabricado hacia adelante produce un `nextDueAt` futuro que gana el `orderBy inspectedAt desc` y deja
    // pasar el gate de ITV por encima de una inspección REAL reprobada/vencida. El error es tipado.
    assertInspectedAtNotFuture(inspectedAt, now);
    const nextDueAt = computeNextInspectionDue(inspectedAt, this.intervalMonths);

    // IDENTIDAD DEL INSPECTOR = server-truth (compliance · integridad del audit). El `inspectorId` que se
    // PERSISTE es SIEMPRE el actor autenticado (del JWT, vía controller `user.userId`), NUNCA un valor del
    // body. La columna prueba QUIÉN inspeccionó: si el cliente pudiera fijarla, un operador atribuiría la
    // ITV a otro inspector y la evidencia de compliance sería spoofeable. Mismo principio que el face-match
    // (la identidad la pone el server, no el body). Por eso el DTO ya NO acepta `inspectorId`.
    //
    // AUTO-REACTIVACIÓN POR ITV (cierre del ciclo suspensión↔reactivación, compliance/seguridad): el insert y
    // el posible levantamiento de la suspensión van en la MISMA tx (outbox-in-tx, FOUNDATION §6). Si esta
    // inspección es VIGENTE (`passed && nextDueAt > now`, MISMO `isInspectionCurrent` del gate) y el vehículo
    // tiene conductor, emitimos `fleet.driver_reactivated` keyeado por `userId` (= Vehicle.driverId; fleet NO
    // traduce a id de perfil, identity resuelve User.id → Driver.id en su consumer, igual que la suspensión).
    //
    // MODELO DE HOLDS (sin latch local): ya NO hay un latch `inspectionSuspendedAt` que consultar para saber si
    // el conductor estaba suspendido por ITV. Emitimos la reactivación INCONDICIONALMENTE cuando la ITV nueva es
    // vigente — identity es el dueño del estado: `reactivateByFleetForUser` quita SOLO el hold INSPECTION_EXPIRED
    // y es IDEMPOTENTE (borrar 0 holds = no-op). Si el conductor no estaba suspendido por ITV, el evento es un
    // no-op honesto en identity (no había hold que quitar) y NO toca las otras causas (documento, DISCIPLINARY).
    // Es el espejo del sweeper, que también re-emite la suspensión sin latch y deja que identity dedup-ee.
    try {
      // El insert + la posible auto-reactivación viven en `createInTx` (tx-aware) para poder REUSARLOS desde
      // `documents.review()`: al aprobar el documento ITV del vehículo, la Inspección se crea en la MISMA tx del
      // CAS (una sola aprobación deja la ITV registrada y, si corresponde, levanta la suspensión — atómico).
      return await this.repo.runInTx((tx) =>
        this.createInTx(
          tx,
          {
            vehicleId: input.vehicleId,
            driverId: vehicle.driverId,
            passed: input.passed,
            inspectedAt,
            nextDueAt,
            notes: input.notes ?? null,
            center: input.center ?? null,
          },
          inspectorId,
          now,
        ),
      );
    } catch (err) {
      // IDEMPOTENCIA (FOUNDATION §0.4): el natural key `[vehicleId, inspectedAt, inspectorId]` colapsa un
      // re-POST (doble click / retry de red) a una sola fila. Dos inspecciones REALES distintas del mismo
      // vehículo tienen `inspectedAt` distinto → no colisionan: el constraint solo atrapa el duplicado
      // exacto. Ante P2002 devolvemos la fila ya escrita (respuesta idempotente, NO un 500), igual que el
      // doble-submit de payment-service con su dedupKey. La reactivación de la fila original ya se emitió en
      // SU tx (este re-POST es el mismo hecho): no re-emitimos (identity ya quitó el hold INSPECTION_EXPIRED →
      // un re-emit sería no-op de todas formas, pero ni siquiera llegamos acá: devolvemos la fila existente).
      if (isUniqueViolation(err)) {
        const existing = await this.repo.findByNaturalKey(input.vehicleId, inspectedAt, inspectorId);
        if (existing) return existing;
      }
      throw err;
    }
  }

  /**
   * Inserta la inspección y —si es VIGENTE (`passed && nextDueAt > now`) y el vehículo tiene conductor— emite
   * `fleet.driver_reactivated`, TODO dentro de la `tx` recibida (outbox-in-tx, FOUNDATION §6). Server-truth del
   * inspector: el `inspectorId` lo pone el caller (actor autenticado), nunca el body.
   *
   * Reutilizable: `create()` la envuelve en su propia tx + idempotencia (P2002); `documents.review()` la llama
   * en la MISMA tx del CAS al APROBAR el documento ITV del vehículo — así una sola aprobación registra la ITV y
   * levanta la suspensión por ITV de forma atómica. Emitimos la reactivación INCONDICIONALMENTE cuando la ITV es
   * vigente: identity quita SOLO el hold INSPECTION_EXPIRED y es idempotente (borrar 0 holds = no-op).
   */
  async createInTx(
    tx: Prisma.TransactionClient,
    params: {
      vehicleId: string;
      // Conductor dueño (User.id = Vehicle.driverId) resuelto por el CALLER, para keyear la reactivación sin
      // que createInTx haga I/O oculto. `null` si el vehículo no tiene conductor → no se emite reactivación.
      driverId: string | null;
      passed: boolean;
      inspectedAt: Date;
      nextDueAt: Date;
      notes?: string | null;
      center?: string | null;
    },
    inspectorId: string,
    now: Date,
  ): Promise<Inspection> {
    const inspection = await tx.inspection.create({
      data: {
        id: uuidv7(),
        vehicleId: params.vehicleId,
        inspectorId,
        inspectedAt: params.inspectedAt,
        passed: params.passed,
        notes: params.notes ?? null,
        center: params.center ?? null,
        nextDueAt: params.nextDueAt,
      },
    });

    if (
      isInspectionCurrent({ passed: inspection.passed, nextDueAt: params.nextDueAt }, now) &&
      params.driverId
    ) {
      const payload: DriverReactivatedPayload = {
        // KEYEADO POR userId (User.id = Vehicle.driverId), NO driverId de perfil: identity resuelve el mapeo.
        userId: params.driverId,
        reason: 'Inspección técnica (ITV) regularizada',
        vehicleId: params.vehicleId,
        inspectionId: inspection.id,
        nextDueAt: params.nextDueAt.toISOString(),
        reactivatedAt: now.toISOString(),
      };
      const envelope = buildFleetEvent(FleetEventType.DRIVER_REACTIVATED, payload);
      await tx.outboxEvent.create({
        data: {
          aggregateId: params.driverId,
          eventType: envelope.eventType,
          envelope: envelope as unknown as Prisma.InputJsonValue,
        },
      });
    }
    return inspection;
  }

  listByVehicle(vehicleId: string): Promise<Inspection[]> {
    return this.repo.listByVehicle(vehicleId);
  }

  /**
   * Lista paginada de inspecciones para el operador (admin), opcionalmente filtrada por vehículo.
   * Paginación cursor por id (uuidv7 ⇒ orden temporal estable).
   */
  async list(opts: {
    vehicleId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<Inspection>> {
    const limit = clampLimit(opts.limit);
    const rows = await this.repo.listPage({
      vehicleId: opts.vehicleId,
      cursor: opts.cursor,
      take: limit + 1,
    });
    return toPage(rows, limit);
  }
}
