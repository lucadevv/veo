/**
 * InspectionsService — registra inspecciones técnicas y calcula su próximo vencimiento (BR-D04).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { uuidv7, NotFoundError } from '@veo/utils';
import { isUniqueViolation } from '@veo/database';
import { PrismaService } from '../infra/prisma.service';
import { clampLimit, toPage, type Page } from '../infra/pagination';
import { computeNextInspectionDue, assertInspectedAtNotFuture } from './inspection-rules';
import type { CreateInspectionDto } from './dto/inspection.dto';
import { Prisma, type Inspection } from '../generated/prisma';
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

  // RESIDUAL (decisión de producto · dueño): NO hay separación-de-deberes plena — hoy el MISMO set de
  // roles que APRUEBA al conductor (COMPLIANCE_SUPERVISOR/ADMIN/SUPERADMIN) puede REGISTRAR la ITV. El
  // anti-futuro (abajo) + la auditoría del registro (admin-bff FleetService.createInspection) cierran lo
  // no-controversial; exigir que el actor que registra la ITV sea DISTINTO del que aprueba queda pendiente
  // del dueño (cambio de modelo de roles), NO se implementa acá.
  async create(input: CreateInspectionDto, inspectorId: string): Promise<Inspection> {
    const vehicle = await this.prisma.read.vehicle.findUnique({ where: { id: input.vehicleId } });
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
    try {
      return await this.prisma.write.inspection.create({
        data: {
          id: uuidv7(),
          vehicleId: input.vehicleId,
          inspectorId,
          inspectedAt,
          passed: input.passed,
          notes: input.notes ?? null,
          nextDueAt,
        },
      });
    } catch (err) {
      // IDEMPOTENCIA (FOUNDATION §0.4): el natural key `[vehicleId, inspectedAt, inspectorId]` colapsa un
      // re-POST (doble click / retry de red) a una sola fila. Dos inspecciones REALES distintas del mismo
      // vehículo tienen `inspectedAt` distinto → no colisionan: el constraint solo atrapa el duplicado
      // exacto. Ante P2002 devolvemos la fila ya escrita (respuesta idempotente, NO un 500), igual que el
      // doble-submit de payment-service con su dedupKey.
      if (isUniqueViolation(err)) {
        const existing = await this.prisma.read.inspection.findUnique({
          where: {
            vehicleId_inspectedAt_inspectorId: {
              vehicleId: input.vehicleId,
              inspectedAt,
              inspectorId,
            },
          },
        });
        if (existing) return existing;
      }
      throw err;
    }
  }

  listByVehicle(vehicleId: string): Promise<Inspection[]> {
    return this.prisma.read.inspection.findMany({
      where: { vehicleId },
      orderBy: { inspectedAt: 'desc' },
    });
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
    const where: Prisma.InspectionWhereInput = {};
    if (opts.vehicleId) where.vehicleId = opts.vehicleId;
    if (opts.cursor) where.id = { lt: opts.cursor };
    const rows = await this.prisma.read.inspection.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    return toPage(rows, limit);
  }
}
