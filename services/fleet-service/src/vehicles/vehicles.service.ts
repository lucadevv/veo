/**
 * VehiclesService — alta y consulta de vehículos (BR-D04: año mínimo, placa válida).
 * El estado documental agregado (docStatus) lo mantiene el cron de vencimientos (ExpirySweeper).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { uuidv7, plateSchema, parseOrThrow, ConflictError, NotFoundError, ValidationError } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { buildFleetEvent, FleetEventType } from '../events/fleet-events';
import { deriveVehicleReviewStatus, isVehicleYearEligible } from './vehicle-rules';
import type { CreateVehicleDto, DriverVehicleResponse, RegisterDriverVehicleDto } from './dto/vehicle.dto';
import { Prisma, type Vehicle } from '../generated/prisma';
import type { Env } from '../config/env.schema';

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
      throw new ValidationError(`El vehículo debe ser del año ${this.minYear} o posterior (BR-D04)`, {
        year: input.year,
        minYear: this.minYear,
      });
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
   * Alta self-service: el conductor registra su propio vehículo durante el onboarding.
   * Reglas: placa válida (plateSchema), año elegible (BR-D04) y placa no duplicada.
   * El vehículo NO se activa: queda `active=false` (pendiente de verificación del operador) y se
   * emite el evento `fleet.vehicle.registered` por outbox en la misma transacción.
   *
   * `driverId` es el **User.id** de identity (el `userId` del token propagado), NO el id de perfil
   * `Driver` de identity; fleet lo persiste tal cual en `Vehicle.driverId` (sin traducir).
   */
  async registerForDriver(driverId: string, input: RegisterDriverVehicleDto): Promise<DriverVehicleResponse> {
    const plate = parseOrThrow(plateSchema, input.plate.trim().toUpperCase(), 'plate');

    if (!isVehicleYearEligible(input.year, this.minYear)) {
      throw new ValidationError(`El vehículo debe ser del año ${this.minYear} o posterior (BR-D04)`, {
        year: input.year,
        minYear: this.minYear,
      });
    }

    const existing = await this.prisma.read.vehicle.findUnique({ where: { plate } });
    if (existing) throw new ConflictError('Ya existe un vehículo con esa placa', { plate });

    const vehicle = await this.prisma.write.$transaction(async (tx) => {
      const created = await tx.vehicle.create({
        data: {
          id: uuidv7(),
          plate,
          make: input.make.trim(),
          model: input.model.trim(),
          year: input.year,
          color: input.color?.trim() ?? '',
          vehicleType: input.vehicleType,
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

    return toDriverVehicleResponse(vehicle);
  }

  /** Rehidrata los vehículos del conductor (más recientes primero). */
  async listForDriver(driverId: string): Promise<DriverVehicleResponse[]> {
    const vehicles = await this.prisma.read.vehicle.findMany({
      where: { driverId },
      orderBy: { createdAt: 'desc' },
    });
    return vehicles.map(toDriverVehicleResponse);
  }
}

/** Proyecta un Vehicle al shape de respuesta self-service con el estado de revisión derivado. */
function toDriverVehicleResponse(vehicle: Vehicle): DriverVehicleResponse {
  return {
    id: vehicle.id,
    plate: vehicle.plate,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    vehicleType: vehicle.vehicleType,
    docStatus: vehicle.docStatus,
    status: deriveVehicleReviewStatus(vehicle),
  };
}
