/**
 * VehiclesService — alta y consulta de vehículos (BR-D04: año mínimo, placa válida).
 * El estado documental agregado (docStatus) lo mantiene el cron de vencimientos (ExpirySweeper).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  uuidv7,
  plateSchema,
  parseOrThrow,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@veo/utils';
import { isUniqueViolation } from '@veo/database';
import { OPERABLE_VEHICLE_CLASSES } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { buildFleetEvent, FleetEventType } from '../events/fleet-events';
import {
  deriveVehicleReviewStatus,
  isVehicleYearEligible,
  pickActiveVehicle,
} from './vehicle-rules';
import { validCertificationsOf } from '../documents/document-rules';
import type {
  CreateVehicleDto,
  DriverVehicleResponse,
  RegisterDriverVehicleDto,
} from './dto/vehicle.dto';
import {
  FleetOwnerType,
  Prisma,
  VehicleDocStatus,
  VehicleModelStatus,
  VehicleType,
  type Vehicle,
} from '../generated/prisma';
import type { Env } from '../config/env.schema';
import { clampLimit, toPage, type Page } from '../infra/pagination';

/**
 * Ids del conductor para el HARD purge. Son DOS porque fleet indexa cada tabla con un id distinto:
 *  - `driverId` (perfil Driver de identity) → FleetDocument ownerType DRIVER.
 *  - `userId` (User.id de identity) → Vehicle.driverId.
 */
export interface PurgeDriverIds {
  driverId: string;
  userId: string;
}

@Injectable()
export class VehiclesService {
  private readonly minYear: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.minYear = config.getOrThrow<number>('VEHICLE_MIN_YEAR');
  }

  /**
   * Gate server-side: la clase de vehículo debe ser OPERABLE hoy (catálogo `OPERABLE_VEHICLE_CLASSES`,
   * fuente única). Mientras la mototaxi esté diferida, MOTO se rechaza acá AUNQUE el cliente lo mande —
   * la UI no autoriza, el backend sí. Cuando se habilite la oferta MOTO, el set crece y deja de bloquear.
   */
  private assertOperableVehicleType(vehicleType: VehicleType): void {
    if (!(OPERABLE_VEHICLE_CLASSES as readonly string[]).includes(vehicleType)) {
      throw new ValidationError('Por ahora solo se registran autos; la mototaxi llega más adelante', {
        vehicleType,
        operable: OPERABLE_VEHICLE_CLASSES,
      });
    }
  }

  async create(input: CreateVehicleDto): Promise<Vehicle> {
    const plate = parseOrThrow(plateSchema, input.plate.trim().toUpperCase(), 'plate');

    if (!isVehicleYearEligible(input.year, this.minYear)) {
      throw new ValidationError(
        `El vehículo debe ser del año ${this.minYear} o posterior (BR-D04)`,
        {
          year: input.year,
          minYear: this.minYear,
        },
      );
    }

    // F4 (C2): si el operador eligió un modelo del CATÁLOGO, make/model/vehicleType se snapshotean del spec
    // APPROVED (server-authoritative) — la MISMA resolución que el alta del conductor (fuente única, sin
    // texto libre divergente); si no, cae al texto libre legacy (scripts/seeds). Resuelto ANTES del create.
    const snapshot = await this.resolveModelSnapshot(input);
    // "Solo autos" (Ola 1): valida la clase YA resuelta (cubre un spec MOTO del catálogo o un MOTO libre).
    this.assertOperableVehicleType(snapshot.vehicleType);

    const existing = await this.prisma.read.vehicle.findUnique({ where: { plate } });
    if (existing) throw new ConflictError('Ya existe un vehículo con esa placa', { plate });

    return this.prisma.write.vehicle.create({
      data: {
        id: uuidv7(),
        plate,
        make: snapshot.make,
        model: snapshot.model,
        year: input.year,
        color: input.color.trim(),
        vehicleType: snapshot.vehicleType,
        modelSpecId: snapshot.modelSpecId,
        fleetId: input.fleetId ?? null,
        insuranceExpiresAt: input.insuranceExpiresAt ? new Date(input.insuranceExpiresAt) : null,
        active: input.active ?? true,
      },
    });
  }

  /**
   * HARD purge de TODA la flota documental de un conductor (re-registro de un conductor NO-OPERADO,
   * orquestado por el admin-bff con guard de trips aguas arriba). Borra REALMENTE, en UNA transacción:
   *  - sus documentos de OPERADOR (FleetDocument ownerType DRIVER, ownerId = driverId), y
   *  - sus vehículos (Vehicle.driverId = userId), CON sus documentos de vehículo asociados.
   *
   * INVARIANTE DE ID (dos ids, NO uno — verificado contra la DB real): fleet indexa cada tabla con un id
   * DISTINTO del mismo conductor, por cómo se escribieron históricamente:
   *  - `FleetDocument` (ownerType DRIVER) usa el id de PERFIL **Driver** de identity (`driverId`), igual que
   *    `GetDriverDocuments({ id: driverId })`. Los documentos del operador se crean con el driverId.
   *  - `Vehicle.driverId` guarda el **User.id** de identity (`userId`), que es lo que el driver-bff propaga
   *    al registrar el vehículo (`registerForDriver` recibe `identity.userId`).
   * Por eso el admin-bff pasa AMBOS ids: el driverId (para los docs) y el userId (para los vehículos). Usar
   * un solo id borraría 0 filas en una de las dos tablas (era el BUG: se pasaba userId a todo → docs 0 filas).
   *
   * NO emite eventos: es un borrado administrativo de algo que nunca operó (sin trips), no un hecho de
   * dominio del ciclo de vida del conductor. Idempotente: re-correr sobre un conductor ya purgado devuelve
   * contadores en 0 (deleteMany no falla si no hay filas).
   */
  async purgeForDriver(
    ids: PurgeDriverIds,
  ): Promise<{ documents: number; vehicles: number; vehicleDocuments: number }> {
    const { driverId, userId } = ids;
    return this.prisma.write.$transaction(async (tx) => {
      // Vehículos del conductor: indexados por userId (lo que el driver-bff persistió en Vehicle.driverId).
      const vehicles = await tx.vehicle.findMany({
        where: { driverId: userId },
        select: { id: true },
      });
      const vehicleIds = vehicles.map((v) => v.id);

      // Documentos de los VEHÍCULOS del conductor (ownerType VEHICLE, ownerId ∈ vehicleIds): sin esto
      // quedarían huérfanos (FleetDocument no tiene FK física a Vehicle, hay que borrarlos explícito).
      const vehicleDocuments =
        vehicleIds.length > 0
          ? await tx.fleetDocument.deleteMany({
              where: { ownerType: FleetOwnerType.VEHICLE, ownerId: { in: vehicleIds } },
            })
          : { count: 0 };

      // Documentos de OPERADOR del conductor (ownerType DRIVER, ownerId = driverId de perfil).
      const documents = await tx.fleetDocument.deleteMany({
        where: { ownerType: FleetOwnerType.DRIVER, ownerId: driverId },
      });

      const deletedVehicles = await tx.vehicle.deleteMany({ where: { driverId: userId } });

      return {
        documents: documents.count,
        vehicles: deletedVehicles.count,
        vehicleDocuments: vehicleDocuments.count,
      };
    });
  }

  async getById(id: string): Promise<Vehicle> {
    const vehicle = await this.prisma.read.vehicle.findUnique({ where: { id } });
    if (!vehicle) throw new NotFoundError('Vehículo no encontrado', { id });
    return vehicle;
  }

  /**
   * Lista paginada de la flota para el operador (admin). Filtros opcionales por estado documental y
   * actividad. Paginación cursor por id (uuidv7 ⇒ orden temporal estable, sin offset costoso).
   */
  async list(opts: {
    docStatus?: VehicleDocStatus;
    active?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<Page<Vehicle>> {
    const limit = clampLimit(opts.limit);
    const where: Prisma.VehicleWhereInput = {};
    if (opts.docStatus) where.docStatus = opts.docStatus;
    if (opts.active !== undefined) where.active = opts.active;
    if (opts.cursor) where.id = { lt: opts.cursor };
    const rows = await this.prisma.read.vehicle.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    return toPage(rows, limit);
  }

  /**
   * Alta self-service: el conductor registra su propio vehículo durante el onboarding.
   * Reglas: placa válida (plateSchema), año elegible (BR-D04).
   *
   * IDEMPOTENCIA OWNERSHIP-AWARE: el wizard del onboarding reintenta el paso (red flaky, doble tap,
   * volver atrás y reenviar). La placa es `@unique` GLOBAL — un 409 a secas bloqueaba al conductor
   * reenviando SU PROPIA placa. Ahora:
   *  - placa de ESTE conductor → no-op idempotente: se ACTUALIZA el vehículo con lo reenviado
   *    (correcciones del wizard: modelo/snapshot, año, color, tipo) y se devuelve. NO se re-emite
   *    `vehicle_registered` (el alta ya ocurrió una vez; un duplicado mentiría el ciclo de vida).
   *  - placa de OTRO conductor → conflicto de dominio real (ConflictError).
   *  - placa libre → alta nueva (active=false, pendiente de verificación) + `vehicle_registered`
   *    por outbox en la MISMA transacción.
   *
   * Race-safety (TOCTOU): el findUnique-luego-escribe NO es atómico entre dos altas concurrentes con
   * la MISMA placa. El `@unique` global es la barrera dura: si la carrera se cuela, el `create` lanza
   * P2002 y lo capturamos para RE-RESOLVER el dueño (no un 500): re-leemos por placa y caemos al
   * camino idempotente (mismo dueño) o al de conflicto (otro dueño). Espeja ConsentsService.record.
   *
   * `driverId` es el id de PERFIL `Driver` de identity (el que viaja propagado desde el driver-bff y el
   * mismo que usa el admin-bff en el purge/approve); fleet lo persiste tal cual en `Vehicle.driverId`.
   */
  async registerForDriver(
    driverId: string,
    input: RegisterDriverVehicleDto,
  ): Promise<DriverVehicleResponse> {
    const plate = parseOrThrow(plateSchema, input.plate.trim().toUpperCase(), 'plate');

    if (!isVehicleYearEligible(input.year, this.minYear)) {
      throw new ValidationError(
        `El vehículo debe ser del año ${this.minYear} o posterior (BR-D04)`,
        {
          year: input.year,
          minYear: this.minYear,
        },
      );
    }

    // B5-2: si el conductor eligió un modelo del catálogo, make/model/vehicleType salen del spec
    // (server-authoritative); si no, caen al texto libre. Resuelto ANTES de la transacción.
    const snapshot = await this.resolveModelSnapshot(input);
    // "Solo autos" (Ola 1): valida la clase YA resuelta — cubre ambos caminos (un spec MOTO del catálogo
    // o un texto libre MOTO se rechazan igual). Server-authoritative, no confía en lo que declara la app.
    this.assertOperableVehicleType(snapshot.vehicleType);

    const existing = await this.prisma.read.vehicle.findUnique({ where: { plate } });
    if (existing) {
      return this.resolveExistingForDriver(driverId, existing, input, snapshot);
    }

    let vehicle: Vehicle;
    try {
      vehicle = await this.prisma.write.$transaction(async (tx) => {
        const created = await tx.vehicle.create({
          data: {
            id: uuidv7(),
            plate,
            make: snapshot.make,
            model: snapshot.model,
            year: input.year,
            color: input.color?.trim() ?? '',
            vehicleType: snapshot.vehicleType,
            modelSpecId: snapshot.modelSpecId,
            driverId,
            // Onboarding: pendiente de verificación, no se activa automáticamente.
            active: false,
          },
        });

        await tx.outboxEvent.create({
          data: {
            aggregateId: created.id,
            eventType: FleetEventType.VEHICLE_REGISTERED,
            envelope: buildFleetEvent(FleetEventType.VEHICLE_REGISTERED, {
              vehicleId: created.id,
              driverId,
              plate: created.plate,
              vehicleType: created.vehicleType,
              registeredAt: created.createdAt.toISOString(),
            }) as unknown as Prisma.InputJsonValue,
          },
        });

        return created;
      });
    } catch (err) {
      // Carrera perdida contra otra alta concurrente con la MISMA placa (el @unique global ganó).
      // Re-resolvemos el dueño en vez de un 500: mismo dueño → idempotente; otro → conflicto.
      if (isUniqueViolation(err, 'plate')) {
        const raced = await this.prisma.write.vehicle.findUnique({ where: { plate } });
        if (raced) return this.resolveExistingForDriver(driverId, raced, input, snapshot);
      }
      throw err;
    }

    // El alta puede convertir al nuevo vehículo en el activo (si es el primero/único operable): lo
    // resolvemos sobre la flota completa del conductor para no mentir el `isActive` de la respuesta.
    const all = await this.prisma.read.vehicle.findMany({ where: { driverId } });
    const active = pickActiveVehicle(all);
    return toDriverVehicleResponse(vehicle, active?.id === vehicle.id);
  }

  /**
   * Resuelve una placa YA existente en el alta self-service según el dueño:
   *  - de ESTE conductor → UPDATE idempotente (correcciones del wizard) SIN re-emitir el evento de alta.
   *  - de OTRO conductor (o flota del operador, driverId=null) → ConflictError de dominio.
   */
  private async resolveExistingForDriver(
    driverId: string,
    existing: Vehicle,
    input: RegisterDriverVehicleDto,
    snapshot: {
      make: string;
      model: string;
      vehicleType: VehicleType;
      modelSpecId: string | null;
    },
  ): Promise<DriverVehicleResponse> {
    if (existing.driverId !== driverId) {
      throw new ConflictError('Esa placa ya está registrada por otro conductor', {
        plate: existing.plate,
      });
    }

    // Mismo dueño: reenvío del wizard ⇒ actualizamos con lo último (snapshot/año/color/tipo). NO
    // tocamos `active` (sigue pendiente de verificación) ni re-emitimos `vehicle_registered`.
    const updated = await this.prisma.write.vehicle.update({
      where: { id: existing.id },
      data: {
        make: snapshot.make,
        model: snapshot.model,
        year: input.year,
        color: input.color?.trim() ?? '',
        vehicleType: snapshot.vehicleType,
        modelSpecId: snapshot.modelSpecId,
      },
    });

    const all = await this.prisma.read.vehicle.findMany({ where: { driverId } });
    const active = pickActiveVehicle(all);
    return toDriverVehicleResponse(updated, active?.id === updated.id);
  }

  /**
   * Resuelve marca/modelo/tipo del alta. Compartido por el alta del CONDUCTOR (B5-2) y la del OPERADOR
   * (F4 · C2) — la misma fuente única, sin duplicar la lógica del catálogo. Dos caminos:
   *  - CON modelSpecId → se eligió un modelo del CATÁLOGO: se valida que exista y esté APPROVED y se
   *    snapshotea make/model/vehicleType del spec (server-authoritative; ignora el texto libre).
   *  - SIN modelSpecId → texto libre legacy: exige make+model y usa el vehicleType del body (default CAR
   *    cuando el caller no lo especifica, p.ej. el alta admin donde el tipo es opcional).
   */
  private async resolveModelSnapshot(input: {
    modelSpecId?: string;
    make?: string;
    model?: string;
    vehicleType?: VehicleType;
  }): Promise<{
    make: string;
    model: string;
    vehicleType: VehicleType;
    modelSpecId: string | null;
  }> {
    if (input.modelSpecId) {
      const spec = await this.prisma.read.vehicleModelSpec.findFirst({
        where: { id: input.modelSpecId, status: VehicleModelStatus.APPROVED },
      });
      if (!spec) {
        throw new ValidationError('El modelo seleccionado no existe o no está aprobado', {
          modelSpecId: input.modelSpecId,
        });
      }
      return {
        make: spec.make,
        model: spec.model,
        vehicleType: spec.vehicleType,
        modelSpecId: spec.id,
      };
    }

    const make = input.make?.trim();
    const model = input.model?.trim();
    if (!make || !model) {
      throw new ValidationError('Indicá la marca y el modelo, o elegí un modelo del catálogo', {
        make: make ?? null,
        model: model ?? null,
      });
    }
    return { make, model, vehicleType: input.vehicleType ?? VehicleType.CAR, modelSpecId: null };
  }

  /** Rehidrata los vehículos del conductor (más recientes primero), marcando cuál es el ACTIVO. */
  async listForDriver(driverId: string): Promise<DriverVehicleResponse[]> {
    const vehicles = await this.prisma.read.vehicle.findMany({
      where: { driverId },
      orderBy: { createdAt: 'desc' },
    });
    const active = pickActiveVehicle(vehicles);
    return vehicles.map((v) => toDriverVehicleResponse(v, v.id === active?.id));
  }

  /**
   * Vehículo ACTIVO (operado) del conductor, server-authoritative: el de `selectedAt` más reciente con
   * docs vigentes (o el más reciente registrado si ninguno fue seleccionado). `null` si no tiene ninguno
   * operable. Lo usa el driver-bff para sellar el tipo en el ping (sin confiar en lo que declara la app).
   */
  async getActiveVehicle(driverId: string): Promise<DriverVehicleResponse | null> {
    const vehicles = await this.prisma.read.vehicle.findMany({ where: { driverId } });
    const active = pickActiveVehicle(vehicles);
    if (!active) return null;
    // B5-3.2 · certificaciones de operador VIGENTES del conductor (del MISMO driverId; ownerType DRIVER).
    // El driver-bff las sella en el ping y dispatch gatea las verticales FAIL-CLOSED. Índice [ownerType,
    // ownerId]; el endpoint lo cachea el driver-bff (TTL 20s), no es hot-path directo.
    const docs = await this.prisma.read.fleetDocument.findMany({
      where: { ownerType: FleetOwnerType.DRIVER, ownerId: driverId },
    });
    const certifications = validCertificationsOf(docs);
    const base: DriverVehicleResponse = {
      ...toDriverVehicleResponse(active, true),
      certifications,
    };
    // B5-3 · enriquece SOLO el vehículo activo con seats/segment del modelSpec elegido, para que el
    // driver-bff los selle en el ping (eligibilidad de oferta en dispatch). Legacy sin modelSpecId →
    // sin attrs (degradación honesta: dispatch no restringe a ese conductor).
    if (!active.modelSpecId) return base;
    const spec = await this.prisma.read.vehicleModelSpec.findUnique({
      where: { id: active.modelSpecId },
    });
    if (!spec) return base;
    return { ...base, seats: spec.seats, segment: spec.segment ?? undefined };
  }

  /**
   * Selecciona el vehículo ACTIVO del conductor (marca `selectedAt = ahora`, así gana por recencia).
   * Anti-IDOR: el vehículo debe ser de ESTE conductor (si no → NotFound, no se filtra existencia ajena).
   * No se puede activar un vehículo con docs VENCIDOS (BR-D04). Idempotente: re-seleccionar el mismo es ok.
   */
  async setActiveVehicle(driverId: string, vehicleId: string): Promise<DriverVehicleResponse> {
    const vehicle = await this.prisma.read.vehicle.findUnique({ where: { id: vehicleId } });
    if (vehicle?.driverId !== driverId) {
      throw new NotFoundError('Vehículo no encontrado');
    }
    if (vehicle.docStatus === VehicleDocStatus.EXPIRED) {
      throw new ValidationError('No podés operar un vehículo con documentos vencidos', {
        vehicleId,
        docStatus: vehicle.docStatus,
      });
    }
    const updated = await this.prisma.write.vehicle.update({
      where: { id: vehicleId },
      data: { selectedAt: new Date() },
    });
    return toDriverVehicleResponse(updated, true);
  }
}

/** Proyecta un Vehicle al shape de respuesta self-service con el estado de revisión derivado. */
function toDriverVehicleResponse(vehicle: Vehicle, isActive: boolean): DriverVehicleResponse {
  return {
    id: vehicle.id,
    plate: vehicle.plate,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    vehicleType: vehicle.vehicleType,
    docStatus: vehicle.docStatus,
    status: deriveVehicleReviewStatus(vehicle),
    isActive,
  };
}
