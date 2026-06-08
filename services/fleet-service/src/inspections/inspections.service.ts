/**
 * InspectionsService — registra inspecciones técnicas y calcula su próximo vencimiento (BR-D04).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { uuidv7, NotFoundError } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { computeNextInspectionDue } from './inspection-rules';
import type { CreateInspectionDto } from './dto/inspection.dto';
import type { Inspection } from '../generated/prisma';
import type { Env } from '../config/env.schema';

@Injectable()
export class InspectionsService {
  private readonly intervalMonths: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.intervalMonths = config.getOrThrow<number>('INSPECTION_INTERVAL_MONTHS');
  }

  async create(input: CreateInspectionDto, inspectorId: string): Promise<Inspection> {
    const vehicle = await this.prisma.read.vehicle.findUnique({ where: { id: input.vehicleId } });
    if (!vehicle) throw new NotFoundError('Vehículo no encontrado', { vehicleId: input.vehicleId });

    const inspectedAt = input.inspectedAt ? new Date(input.inspectedAt) : new Date();
    const nextDueAt = computeNextInspectionDue(inspectedAt, this.intervalMonths);

    return this.prisma.write.inspection.create({
      data: {
        id: uuidv7(),
        vehicleId: input.vehicleId,
        inspectorId: input.inspectorId ?? inspectorId,
        inspectedAt,
        passed: input.passed,
        notes: input.notes ?? null,
        nextDueAt,
      },
    });
  }

  listByVehicle(vehicleId: string): Promise<Inspection[]> {
    return this.prisma.read.inspection.findMany({
      where: { vehicleId },
      orderBy: { inspectedAt: 'desc' },
    });
  }
}
