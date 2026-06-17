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

@Injectable()
export class VehiclesService {
  private readonly minYear: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.minYear = config.getOrThrow<number>('VEHICLE_MIN_YEAR');
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

    const existing = await this.prisma.read.vehicle.findUnique({ where: { plate } });
    if (existing) throw new ConflictError('Ya existe un vehículo con esa placa', { plate });

    return this.prisma.write.vehicle.create({
      data: {
        id: uuidv7(),
        plate,
        make: input.make.trim(),
        model: input.model.trim(),
        year: input.year,
        color: input.color.trim(),
        vehicleType: input.vehicleType ?? 'CAR',
        fleetId: input.fleetId ?? null,
        insuranceExpiresAt: input.insuranceExpiresAt ? new Date(input.insuranceExpiresAt) : null,
        active: input.active ?? true,
      },
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
   * Reglas: placa válida (plateSchema), año elegible (BR-D04) y placa no duplicada.
   * El vehículo NO se activa: queda `active=false` (pendiente de verificación del operador) y se
   * emite el evento `fleet.vehicle.registered` por outbox en la misma transacción.
   *
   * `driverId` es el **User.id** de identity (el `userId` del token propagado), NO el id de perfil
   * `Driver` de identity; fleet lo persiste tal cual en `Vehicle.driverId` (sin traducir).
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

    const existing = await this.prisma.read.vehicle.findUnique({ where: { plate } });
    if (existing) throw new ConflictError('Ya existe un vehículo con esa placa', { plate });

    // B5-2: si el conductor eligió un modelo del catálogo, make/model/vehicleType salen del spec
    // (server-authoritative); si no, caen al texto libre. Resuelto ANTES de la transacción.
    const snapshot = await this.resolveModelSnapshot(input);

    const vehicle = await this.prisma.write.$transaction(async (tx) => {
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

    // El alta puede convertir al nuevo vehículo en el activo (si es el primero/único operable): lo
    // resolvemos sobre la flota completa del conductor para no mentir el `isActive` de la respuesta.
    const all = await this.prisma.read.vehicle.findMany({ where: { driverId } });
    const active = pickActiveVehicle(all);
    return toDriverVehicleResponse(vehicle, active?.id === vehicle.id);
  }

  /**
   * Resuelve marca/modelo/tipo del alta. Dos caminos (B5-2):
   *  - CON modelSpecId → el conductor eligió un modelo del CATÁLOGO: se valida que exista y esté APPROVED
   *    y se snapshotea make/model/vehicleType del spec (server-authoritative; ignora el texto libre).
   *  - SIN modelSpecId → texto libre legacy: exige make+model y usa el vehicleType del body.
   */
  private async resolveModelSnapshot(input: RegisterDriverVehicleDto): Promise<{
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
    return { make, model, vehicleType: input.vehicleType, modelSpecId: null };
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
    if (!vehicle || vehicle.driverId !== driverId) {
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
