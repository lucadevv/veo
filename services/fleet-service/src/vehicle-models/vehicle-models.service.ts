/**
 * VehicleModelsService (B5-2.a) — lectura del CATÁLOGO CURADO de modelos de vehículo.
 * Fuente de seats/segment/combustible/eficiencia por make+model+rango de años. El conductor ELIGE de
 * este catálogo en el onboarding (no tipea make/model libre) y el panel admin lo consulta.
 *
 * Esta fase entrega solo LECTURA del catálogo APROBADO: el alta de modelos nuevos (PENDING_REVIEW) y la
 * aprobación por el operador son B5-2.c. La elección por el conductor (Vehicle.modelSpecId) es B5-2.b.
 */
import { Injectable } from '@nestjs/common';
import { uuidv7, ConflictError, NotFoundError, ValidationError } from '@veo/utils';
import { isUniqueViolation } from '@veo/database';
import { VehicleSegment, EnergySource } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import {
  buildFleetEvent,
  FleetEventType,
  type VehicleModelReviewedPayload,
} from '../events/fleet-events';
import {
  Prisma,
  VehicleModelStatus,
  VehicleType,
  type VehicleModelSpec,
} from '../generated/prisma';
import { clampLimit, toPage, type Page } from '../infra/pagination';
import type {
  ApproveVehicleModelDto,
  RequestVehicleModelDto,
  VehicleModelReviewView,
  VehicleModelSpecView,
} from './dto/vehicle-model.dto';

@Injectable()
export class VehicleModelsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Catálogo APROBADO, paginado por cursor. El keyset es por `id` (mismo campo que el `orderBy`, para que
   * el cursor sea consistente — ordenar por make/model y cursorear por id saltearía filas). Filtros
   * opcionales: `vehicleType` (el selector de un mototaxista solo trae motos) y `q` (contains
   * case-insensitive sobre marca/modelo). Solo devuelve modelos APPROVED — los PENDING/REJECTED no se
   * ofrecen para elegir. El catálogo es chico; el cliente ordena alfabético al render si lo necesita.
   */
  async listApproved(opts: {
    vehicleType?: VehicleType;
    q?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<VehicleModelSpecView>> {
    const limit = clampLimit(opts.limit);
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

    const rows = await this.prisma.read.vehicleModelSpec.findMany({
      where,
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    const page = toPage(rows, limit);
    return { ...page, items: page.items.map(toView) };
  }

  /**
   * Un modelo APROBADO del catálogo por id. Filtra por status=APPROVED para no exponer PENDING/REJECTED
   * (alineado con listApproved): el único consumidor de esta fase es el selector del onboarding. La vista
   * admin de cualquier estado llega role-gated en B5-2.c — no se abre el hueco acá. NotFound si no existe
   * o no está aprobado (no se filtra la existencia de un modelo no-aprobado).
   */
  async getById(id: string): Promise<VehicleModelSpecView> {
    const spec = await this.prisma.read.vehicleModelSpec.findFirst({
      where: { id, status: VehicleModelStatus.APPROVED },
    });
    if (!spec) throw new NotFoundError('Modelo de vehículo no encontrado', { id });
    return toView(spec);
  }

  /**
   * B5-2.c · el conductor SOLICITA un modelo que no está en el catálogo. Entra PENDING_REVIEW con lo que
   * conoce (make/model/años/tipo/asientos); el operador completa la ficha técnica al aprobar. Dedup por
   * (make, model, yearFrom): si ya existe, no se crea un duplicado — se informa según su estado.
   */
  async requestModel(
    requestedBy: string,
    input: RequestVehicleModelDto,
  ): Promise<VehicleModelReviewView> {
    if (input.yearTo < input.yearFrom) {
      throw new ValidationError('El año "hasta" no puede ser menor que el año "desde"', {
        yearFrom: input.yearFrom,
        yearTo: input.yearTo,
      });
    }
    const make = input.make.trim();
    const model = input.model.trim();

    // Dedup case-insensitive (el unique de DB es case-sensitive: "Toyota" vs "toyota" no chocarían;
    // este pre-check atrapa la variación de mayúsculas en el caso secuencial).
    const existing = await this.prisma.read.vehicleModelSpec.findFirst({
      where: {
        make: { equals: make, mode: 'insensitive' },
        model: { equals: model, mode: 'insensitive' },
        yearFrom: input.yearFrom,
      },
    });
    if (existing) throw this.duplicateModelError(make, model, input.yearFrom, existing.status);

    try {
      const created = await this.prisma.write.vehicleModelSpec.create({
        data: {
          id: uuidv7(),
          make,
          model,
          yearFrom: input.yearFrom,
          yearTo: input.yearTo,
          vehicleType: input.vehicleType,
          seats: input.seats,
          // Ficha técnica vacía: la completa el operador al aprobar (no inventamos datos).
          segment: null,
          energySource: null,
          efficiency: null,
          status: VehicleModelStatus.PENDING_REVIEW,
          requestedBy,
        },
      });
      return toReviewView(created);
    } catch (err) {
      // Carrera con otra solicitud idéntica entre el pre-check y el create → el unique de DB gana:
      // lo mapeamos a 409 (no 500), idempotencia de la dedup.
      if (isUniqueViolation(err)) {
        throw this.duplicateModelError(make, model, input.yearFrom, null);
      }
      throw err;
    }
  }

  /** Conflicto de modelo duplicado, con mensaje según el estado del existente (si se conoce). */
  private duplicateModelError(
    make: string,
    model: string,
    yearFrom: number,
    status: VehicleModelStatus | null,
  ): ConflictError {
    const message =
      status === VehicleModelStatus.APPROVED
        ? 'Ese modelo ya está en el catálogo: elegilo de la lista'
        : 'Ese modelo ya fue solicitado y está en revisión';
    return new ConflictError(message, { make, model, yearFrom, status });
  }

  /**
   * Cola de revisión del OPERADOR: lista por estado (default PENDING_REVIEW), keyset por id. Devuelve la
   * vista admin (campos técnicos pueden venir null + quién solicitó/verificó).
   */
  async listForReview(opts: {
    status?: VehicleModelStatus;
    cursor?: string;
    limit?: number;
  }): Promise<Page<VehicleModelReviewView>> {
    const limit = clampLimit(opts.limit);
    const where: Prisma.VehicleModelSpecWhereInput = {
      status: opts.status ?? VehicleModelStatus.PENDING_REVIEW,
    };
    if (opts.cursor) where.id = { gt: opts.cursor };

    const rows = await this.prisma.read.vehicleModelSpec.findMany({
      where,
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    const page = toPage(rows, limit);
    return { ...page, items: page.items.map(toReviewView) };
  }

  /**
   * APRUEBA una solicitud: el operador completa la ficha técnica (segment/energía/eficiencia) y opcionalmente
   * corrige asientos. Transición PENDING_REVIEW → APPROVED (única válida); aprobar algo no-PENDING → 409.
   * Acá se cumple la invariante "APPROVED ⇒ ficha completa".
   */
  async approve(
    id: string,
    verifiedBy: string,
    input: ApproveVehicleModelDto,
  ): Promise<VehicleModelReviewView> {
    return this.transition(id, {
      segment: input.segment,
      energySource: input.energySource,
      efficiency: input.efficiency,
      ...(input.seats !== undefined ? { seats: input.seats } : {}),
      status: VehicleModelStatus.APPROVED,
      verifiedBy,
    });
  }

  /** RECHAZA una solicitud. Transición PENDING_REVIEW → REJECTED (única válida); rechazar no-PENDING → 409. */
  async reject(id: string, verifiedBy: string): Promise<VehicleModelReviewView> {
    return this.transition(id, { status: VehicleModelStatus.REJECTED, verifiedBy });
  }

  /**
   * Aplica una transición desde PENDING_REVIEW de forma ATÓMICA (CAS): el `updateMany` con
   * `status: PENDING_REVIEW` en el WHERE garantiza que solo gana UN operador en concurrencia (count===1);
   * si otro ya resolvió el modelo (o no existe), count===0 y se distingue NotFound vs Conflict.
   * Cierra el TOCTOU de leer-y-luego-escribir sin transacción.
   */
  private async transition(
    id: string,
    data: Prisma.VehicleModelSpecUpdateManyMutationInput,
  ): Promise<VehicleModelReviewView> {
    const updated = await this.prisma.write.$transaction(async (tx) => {
      const res = await tx.vehicleModelSpec.updateMany({
        where: { id, status: VehicleModelStatus.PENDING_REVIEW },
        data,
      });
      if (res.count === 0) {
        const spec = await tx.vehicleModelSpec.findUnique({ where: { id } });
        if (!spec) throw new NotFoundError('Modelo de vehículo no encontrado', { id });
        throw new ConflictError('El modelo ya fue revisado (no está pendiente)', {
          id,
          status: spec.status,
        });
      }

      const row = await tx.vehicleModelSpec.findUniqueOrThrow({ where: { id } });

      // El operador resolvió la solicitud (APPROVED/REJECTED): el conductor que la pidió debe enterarse
      // del veredicto. El `verdict` se deriva del status FINAL ya tipado (`VehicleModelStatus`, no string
      // suelto); otros estados no notifican (no son un veredicto). Si `requestedBy` falta (filas viejas
      // pre-feature) NO emitimos: no hay destinatario para el push — degradación honesta, la transición
      // se completa igual.
      const verdict = verdictForStatus(row.status);
      if (verdict !== null && row.requestedBy) {
        const payload: VehicleModelReviewedPayload = {
          modelId: row.id,
          requestedBy: row.requestedBy,
          verdict,
          make: row.make,
          model: row.model,
          reviewedAt: new Date().toISOString(),
        };
        await tx.outboxEvent.create({
          data: {
            aggregateId: row.id,
            eventType: FleetEventType.VEHICLE_MODEL_REVIEWED,
            envelope: buildFleetEvent(
              FleetEventType.VEHICLE_MODEL_REVIEWED,
              payload,
            ) as unknown as Prisma.InputJsonValue,
          },
        });
      }

      return row;
    });
    return toReviewView(updated);
  }
}

/**
 * Mapea el estado FINAL de la transición al `verdict` del evento (contrato @veo/events). Solo los estados
 * resolutivos (APPROVED/REJECTED) son un veredicto; cualquier otro ⇒ null (no se notifica). El switch
 * sobre el enum TIPADO `VehicleModelStatus` evita strings sueltos y es exhaustivo en compile-time.
 */
function verdictForStatus(
  status: VehicleModelStatus,
): VehicleModelReviewedPayload['verdict'] | null {
  switch (status) {
    case VehicleModelStatus.APPROVED:
      return 'APPROVED';
    case VehicleModelStatus.REJECTED:
      return 'REJECTED';
    default:
      return null;
  }
}

/**
 * Proyecta una fila del catálogo al view PÚBLICO. Solo se llama con filas APPROVED (listApproved/getById
 * filtran por status), y la invariante de la aprobación garantiza que la ficha técnica está completa, así
 * que segment/energySource/efficiency son no-null acá (el `!`/cast lo asume con esa precondición).
 */
function toView(spec: VehicleModelSpec): VehicleModelSpecView {
  return {
    id: spec.id,
    make: spec.make,
    model: spec.model,
    yearFrom: spec.yearFrom,
    yearTo: spec.yearTo,
    vehicleType: spec.vehicleType,
    seats: spec.seats,
    segment: spec.segment as VehicleSegment,
    energySource: spec.energySource as EnergySource,
    // Invariante documentado arriba: solo se proyectan filas APPROVED, cuya ficha técnica está completa.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    efficiency: spec.efficiency!,
  };
}

/**
 * Proyecta al view ADMIN (cola de revisión): conserva el estado y quién solicitó/verificó, y deja la ficha
 * técnica como null si la solicitud aún no se aprobó (degradación honesta — no inventa datos).
 */
function toReviewView(spec: VehicleModelSpec): VehicleModelReviewView {
  return {
    id: spec.id,
    make: spec.make,
    model: spec.model,
    yearFrom: spec.yearFrom,
    yearTo: spec.yearTo,
    vehicleType: spec.vehicleType,
    seats: spec.seats,
    segment: spec.segment as VehicleSegment | null,
    energySource: spec.energySource as EnergySource | null,
    efficiency: spec.efficiency,
    status: spec.status,
    requestedBy: spec.requestedBy,
    verifiedBy: spec.verifiedBy,
    createdAt: spec.createdAt.toISOString(),
  };
}
