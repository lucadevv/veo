/**
 * Controlador gRPC de fleet (paquete veo.fleet.v1.FleetService).
 * Lectura síncrona de vehículos y documentos para otros servicios (identity/admin).
 * Devuelve `found=false` en vez de lanzar, para que el llamante decida.
 */
import { Controller, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus, type Metadata } from '@grpc/grpc-js';
import { verifyGrpcIdentity, INTERNAL_IDENTITY_ALLOWED_AUDIENCES, type InternalAudience } from '@veo/auth';
import { PrismaService } from '../infra/prisma.service';
import {
  deriveVehicleReviewStatus,
  hasRequiredVehicleDocsOperable,
  pickActiveVehicle,
  VehicleReviewStatus,
} from '../vehicles/vehicle-rules';
import {
  inspectionInvalidReason,
  isInspectionCurrent,
  InspectionInvalidReason,
} from '../inspections/inspection-rules';
import {
  FleetDocumentStatus,
  FleetDocumentType,
  FleetOwnerType,
  VehicleDocStatus,
  VehicleModelStatus,
  type Vehicle,
} from '../generated/prisma';
import type { Env } from '../config/env.schema';

interface GetByIdRequest {
  id: string;
}

/** fleet.GetVehicleCounts — conteo de vehículos por docStatus (stat cards del admin). */
interface VehicleCountsReply {
  valid: number;
  expiringSoon: number;
  expired: number;
}

/** fleet.GetReviewQueueCounts — conteo de las colas de revisión de flota (cola unificada del admin). */
interface ReviewQueueCountsReply {
  docsPendingReview: number;
  docsExpiringSoon: number;
  modelsPendingReview: number;
}

/** fleet.GetDriverDocsCompleteness — completitud documental por conductor (REQUERIDOS en VALID / total). */
interface DriverDocsCompletenessReply {
  items: { driverId: string; validRequired: number; requiredTotal: number }[];
}

/** Documentos DRIVER-scoped OBLIGATORIOS para operar (espeja REQUIRED_DRIVER_DOC_TYPES del admin-bff). */
const REQUIRED_DRIVER_DOC_TYPES = [
  FleetDocumentType.LICENSE_A1,
  FleetDocumentType.SOAT,
  FleetDocumentType.PROPERTY_CARD,
  FleetDocumentType.VEHICLE_PHOTO,
] as const;

interface GetByIdsRequest {
  ids: string[];
}

interface VehicleReply {
  id: string;
  plate: string;
  make: string;
  model: string;
  year: number;
  color: string;
  /// Ola 2B · tier moto-taxi: tipo de vehículo (CAR|MOTO).
  vehicleType: string;
  docStatus: string;
  active: boolean;
  found: boolean;
  /// Estado de revisión derivado (PENDING_REVIEW|ACTIVE) para el onboarding self-service.
  status: string;
}

interface DriverVehiclesReply {
  driverId: string;
  vehicles: VehicleReply[];
}

interface VehiclesReply {
  vehicles: VehicleReply[];
}

/// Imagen de un documento (sub-lote 3A): clave S3 + cara (FRONT|BACK|SINGLE) + orden.
interface DocumentImageReply {
  s3Key: string;
  side: string;
  order: number;
}

interface FleetDocumentReply {
  id: string;
  ownerType: string;
  ownerId: string;
  type: string;
  documentNumber: string;
  status: string;
  expiresAt: string;
  /// DEPRECADO (sub-lote 3A): primera imagen (backward-compat). El driver-bff NO lo proyecta al conductor.
  fileS3Key: string;
  rejectionReason: string;
  /// Imágenes del documento (1..N caras). Admin review las firma; el driver-bff mapea un subconjunto.
  images: DocumentImageReply[];
}

interface DriverDocumentsReply {
  driverId: string;
  documents: FleetDocumentReply[];
}

/// Vigencia de la ITV del vehículo OPERADO del conductor (gate de aprobación · compliance).
interface DriverInspectionStatusReply {
  current: boolean;
  hasVehicle: boolean;
  vehicleId: string;
  plate: string;
  nextDueAt: string;
  passed: boolean;
  /// NONE|NOT_PASSED|OVERDUE|NO_VEHICLE; "" cuando current=true.
  invalidReason: string;
}

/// Motivo extra (fuera del enum de inspección): el conductor no tiene NINGÚN vehículo operable.
const NO_VEHICLE_REASON = 'NO_VEHICLE';

const EMPTY_VEHICLE: VehicleReply = {
  id: '',
  plate: '',
  make: '',
  model: '',
  year: 0,
  color: '',
  vehicleType: '',
  docStatus: '',
  active: false,
  found: false,
  status: '',
};

/**
 * Mapea un Vehicle de Prisma al reply gRPC (found=true). `docsOperable` lo PRECOMPUTA el handler desde los
 * documentos REQUERIDOS del vehículo (SOAT+ITV presentes+aprobados+vigentes, ownerType=VEHICLE) — no se deriva
 * acá porque cargarlos es I/O y los handlers de lista los batchean (anti-N+1).
 */
function toVehicleReply(v: Vehicle, docsOperable: boolean): VehicleReply {
  // Operabilidad DERIVADA de señales reales (docs requeridos SOAT+ITV operables + ficha linkeada), no del flag
  // `active` stored que nunca se flipeaba. `active` y `status` del reply reflejan la MISMA señal derivada — el
  // gate de carpool (que chequea ambos por defensa en profundidad) queda coherente y deja de bloquear por un
  // flag muerto, SIN sobre-desbloquear (un vehículo sin SOAT/ITV operables jamás deriva a ACTIVE).
  const reviewStatus = deriveVehicleReviewStatus({ docsOperable, modelSpecId: v.modelSpecId });
  return {
    id: v.id,
    plate: v.plate,
    make: v.make,
    model: v.model,
    year: v.year,
    color: v.color,
    vehicleType: v.vehicleType,
    docStatus: v.docStatus,
    active: reviewStatus === VehicleReviewStatus.ACTIVE,
    found: true,
    status: reviewStatus,
  };
}

@Controller()
export class FleetGrpcController {
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    @Inject(INTERNAL_IDENTITY_ALLOWED_AUDIENCES)
    private readonly allowedAudiences: readonly InternalAudience[],
  ) {
    this.secret = config.get('INTERNAL_IDENTITY_SECRET', { infer: true });
  }

  /** Rechaza la RPC si la metadata no trae una identidad interna firmada (HMAC) válida. */
  private requireIdentity(metadata: Metadata): void {
    const identity = verifyGrpcIdentity(metadata, this.secret, { allowedAudiences: this.allowedAudiences });
    if (!identity) {
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'Identidad interna inválida o ausente',
      });
    }
  }

  /**
   * Operabilidad documental (SOAT+ITV) de un set de vehículos, BATCHED en UNA query (anti-N+1): los docs
   * REQUERIDOS del vehículo son FleetDocument ownerType=VEHICLE, ownerId=vehicle.id (NO ownerType=DRIVER —
   * esos son las certificaciones de operador del conductor, otra cosa). Devuelve un mapa vehicleId→docsOperable
   * (false para un vehículo sin docs requeridos operables). Espeja el batch de `purgeForDriver`/`enrichWithSpec`.
   *
   * El `db` lo ELIGE el caller según freshness: el gate de DINERO (GetVehicle, que alimenta reserve/approve del
   * carpooling) pasa el PRIMARY (`prisma.write`) — un doc REVOCADO por el admin debe verse al instante, no tras
   * el lag de réplica (read-write §: nunca leer de réplica en un flujo crítico). Los caminos de display/refinamiento
   * (batch de búsqueda, rehidratación) pasan la RÉPLICA (`prisma.read`).
   */
  private async vehicleDocsOperableMap(
    db: PrismaService['read'],
    vehicleIds: readonly string[],
  ): Promise<Map<string, boolean>> {
    const operable = new Map<string, boolean>();
    if (vehicleIds.length === 0) return operable;
    const docs = await db.fleetDocument.findMany({
      where: { ownerType: FleetOwnerType.VEHICLE, ownerId: { in: [...vehicleIds] } },
    });
    const byOwner = new Map<string, typeof docs>();
    for (const d of docs) {
      const list = byOwner.get(d.ownerId);
      if (list) list.push(d);
      else byOwner.set(d.ownerId, [d]);
    }
    for (const vehicleId of vehicleIds) {
      operable.set(vehicleId, hasRequiredVehicleDocsOperable(byOwner.get(vehicleId) ?? []));
    }
    return operable;
  }

  /**
   * Vehículo por id — GATE DE DINERO. Lo consume el carpooling (booking) en `getDetail` (fail-closed),
   * `reserve` (INSTANT_BOOKING cobra al instante) y `approve` (REVISION cobra al aprobar): los tres son
   * AUTORITATIVOS sobre operabilidad, así que leen del PRIMARY (`prisma.write`), NO de la réplica — un doc
   * REVOCADO por el admin (write a primary) debe verse en el mismo instante, sin la ventana de lag de la
   * réplica eventualmente consistente (read-write §: nunca leer de réplica en un flujo crítico).
   */
  @GrpcMethod('FleetService', 'GetVehicle')
  async getVehicle({ id }: GetByIdRequest, metadata: Metadata): Promise<VehicleReply> {
    this.requireIdentity(metadata);
    const v = await this.prisma.write.vehicle.findUnique({ where: { id } });
    if (!v) return EMPTY_VEHICLE;
    const operableById = await this.vehicleDocsOperableMap(this.prisma.write, [v.id]);
    return toVehicleReply(v, operableById.get(v.id) ?? false);
  }

  /**
   * Conteo de vehículos por estado documental (docStatus · stat cards del panel admin). groupBy AGREGADO en la
   * réplica de lectura (no trae filas), servido por el índice sobre doc_status; un estado sin filas no aparece →
   * default 0. Sin PII: solo enteros. El gate de identidad interna (requireIdentity) acota a los rieles permitidos.
   */
  @GrpcMethod('FleetService', 'GetVehicleCounts')
  async getVehicleCounts(_request: unknown, metadata: Metadata): Promise<VehicleCountsReply> {
    this.requireIdentity(metadata);
    const groups = await this.prisma.read.vehicle.groupBy({
      by: ['docStatus'],
      _count: { _all: true },
    });
    const countOf = (docStatus: VehicleDocStatus): number =>
      groups.find((g) => g.docStatus === docStatus)?._count._all ?? 0;
    return {
      valid: countOf(VehicleDocStatus.VALID),
      expiringSoon: countOf(VehicleDocStatus.EXPIRING_SOON),
      expired: countOf(VehicleDocStatus.EXPIRED),
    };
  }

  /**
   * Conteo de las COLAS DE REVISIÓN de flota para la cola unificada del panel: documentos por revisar
   * (PENDING_REVIEW), documentos por vencer (EXPIRING_SOON) y modelos de vehículo por curar (PENDING_REVIEW).
   * Tres counts en PARALELO sobre la réplica de lectura (servidos por los índices de status); sin PII, solo
   * enteros. El gate de identidad interna (requireIdentity) acota a los rieles permitidos.
   */
  @GrpcMethod('FleetService', 'GetReviewQueueCounts')
  async getReviewQueueCounts(
    _request: unknown,
    metadata: Metadata,
  ): Promise<ReviewQueueCountsReply> {
    this.requireIdentity(metadata);
    const [docsPendingReview, docsExpiringSoon, modelsPendingReview] = await Promise.all([
      this.prisma.read.fleetDocument.count({
        where: { status: FleetDocumentStatus.PENDING_REVIEW },
      }),
      this.prisma.read.fleetDocument.count({
        where: { status: FleetDocumentStatus.EXPIRING_SOON },
      }),
      this.prisma.read.vehicleModelSpec.count({
        where: { status: VehicleModelStatus.PENDING_REVIEW },
      }),
    ]);
    return { docsPendingReview, docsExpiringSoon, modelsPendingReview };
  }

  /**
   * Completitud documental de VARIOS conductores en UNA query (anti-N+1), para la columna "Documentos X/Y" +
   * el embudo (sin docs / listos) del panel. `ids` = Driver.id (los docs DRIVER-scoped se indexan por
   * ownerId=Driver.id, servido por @@index([ownerType, ownerId])). Cuenta los REQUERIDOS DISTINTOS en estado
   * VALID por conductor. Sin PII: solo enteros. Un id sin docs devuelve validRequired=0 (no se omite).
   */
  @GrpcMethod('FleetService', 'GetDriverDocsCompleteness')
  async getDriverDocsCompleteness(
    { ids }: GetByIdsRequest,
    metadata: Metadata,
  ): Promise<DriverDocsCompletenessReply> {
    this.requireIdentity(metadata);
    if (!ids || ids.length === 0) return { items: [] };
    const required = REQUIRED_DRIVER_DOC_TYPES;
    const docs = await this.prisma.read.fleetDocument.findMany({
      where: {
        ownerType: FleetOwnerType.DRIVER,
        ownerId: { in: ids },
        type: { in: [...required] },
        status: FleetDocumentStatus.VALID,
      },
      select: { ownerId: true, type: true },
    });
    // Conjunto de REQUERIDOS-en-VALID por conductor (dedup por tipo → cuenta distinct, no filas repetidas).
    const byOwner = new Map<string, Set<FleetDocumentType>>();
    for (const d of docs) {
      let set = byOwner.get(d.ownerId);
      if (!set) {
        set = new Set();
        byOwner.set(d.ownerId, set);
      }
      set.add(d.type);
    }
    return {
      items: ids.map((id) => ({
        driverId: id,
        validRequired: byOwner.get(id)?.size ?? 0,
        requiredTotal: required.length,
      })),
    };
  }

  /**
   * Lote 3b — lectura BATCH de vehículos por id (anti-N+1). La consume la BÚSQUEDA de carpooling (booking) para
   * filtrar las ofertas cuyo vehículo dejó de ser operable. Trae un VehicleReply por cada id ENCONTRADO; los ids
   * inexistentes se OMITEN (el caller trata "ausente del map" como no-operable). DOS queries fijas (vehicles +
   * docs batched), nunca N. El `status`/`active` derivados son la MISMA señal que GetVehicle (toVehicleReply).
   */
  @GrpcMethod('FleetService', 'GetVehiclesByIds')
  async getVehiclesByIds(
    { ids }: GetByIdsRequest,
    metadata: Metadata,
  ): Promise<VehiclesReply> {
    this.requireIdentity(metadata);
    const uniqueIds = [...new Set(ids ?? [])];
    if (uniqueIds.length === 0) return { vehicles: [] };
    const vehicles = await this.prisma.read.vehicle.findMany({
      where: { id: { in: uniqueIds } },
    });
    // ANTI-N+1: los docs de TODOS los vehículos en UNA query (la 2da), agrupados por vehicleId.
    // Réplica: la búsqueda es un REFINAMIENTO best-effort de display, no el gate autoritativo (ese es GetVehicle).
    const operableById = await this.vehicleDocsOperableMap(this.prisma.read, vehicles.map((v) => v.id));
    return {
      vehicles: vehicles.map((v) => toVehicleReply(v, operableById.get(v.id) ?? false)),
    };
  }

  /** Rehidratación: vehículos registrados por el conductor (id = driverId de identity). */
  @GrpcMethod('FleetService', 'GetDriverVehicles')
  async getDriverVehicles(
    { id }: GetByIdRequest,
    metadata: Metadata,
  ): Promise<DriverVehiclesReply> {
    this.requireIdentity(metadata);
    const vehicles = await this.prisma.read.vehicle.findMany({
      where: { driverId: id },
      orderBy: { createdAt: 'desc' },
    });
    // ANTI-N+1: los docs de TODOS los vehículos en UNA query, agrupados por vehicleId (no una por vehículo).
    const operableById = await this.vehicleDocsOperableMap(this.prisma.read, vehicles.map((v) => v.id));
    return {
      driverId: id,
      vehicles: vehicles.map((v) => toVehicleReply(v, operableById.get(v.id) ?? false)),
    };
  }

  /**
   * Vehículo OPERADO del conductor — FUENTE ÚNICA del "vehículo que el conductor maneja". Resuelve con
   * `pickActiveVehicle` (selector AUTORITATIVO: selectedAt más reciente con docs vigentes), el MISMO que
   * usan el gate de ITV (getDriverInspectionStatus), el ping del driver-bff (`/drivers/vehicles/active`)
   * y el alta self-service. `id` = User.id (Vehicle.driverId). `found=false` si no tiene ninguno operable.
   * Dispatch lo consume al adjudicar para que el vehicleId del viaje NO diverja de lo que opera el conductor.
   */
  @GrpcMethod('FleetService', 'GetDriverActiveVehicle')
  async getDriverActiveVehicle(
    { id }: GetByIdRequest,
    metadata: Metadata,
  ): Promise<VehicleReply> {
    this.requireIdentity(metadata);
    const vehicles = await this.prisma.read.vehicle.findMany({ where: { driverId: id } });
    const active = pickActiveVehicle(vehicles);
    if (!active) return EMPTY_VEHICLE;
    const operableById = await this.vehicleDocsOperableMap(this.prisma.read, [active.id]);
    return toVehicleReply(active, operableById.get(active.id) ?? false);
  }

  @GrpcMethod('FleetService', 'GetDriverDocuments')
  async getDriverDocuments(
    { id }: GetByIdRequest,
    metadata: Metadata,
  ): Promise<DriverDocumentsReply> {
    this.requireIdentity(metadata);
    const docs = await this.prisma.read.fleetDocument.findMany({
      where: { ownerType: FleetOwnerType.DRIVER, ownerId: id },
      orderBy: { createdAt: 'desc' },
      include: { images: { orderBy: { order: 'asc' } } },
    });
    return {
      driverId: id,
      documents: docs.map((d) => ({
        id: d.id,
        ownerType: d.ownerType,
        ownerId: d.ownerId,
        type: d.type,
        documentNumber: d.documentNumber,
        status: d.status,
        expiresAt: d.expiresAt ? d.expiresAt.toISOString() : '',
        // DEPRECADO: primera imagen (backward-compat). proto3 default "" si no hay archivo aún.
        fileS3Key: d.fileS3Key ?? '',
        // M5: motivo del rechazo que escribe el operador (proto3 default "" si no hay). El conductor lo ve.
        rejectionReason: d.rejectionReason ?? '',
        // Sub-lote 3A: las N imágenes (ordenadas). Admin las firma; el conductor recibe un subconjunto.
        images: d.images.map((img) => ({ s3Key: img.s3Key, side: img.side, order: img.order })),
      })),
    };
  }

  /**
   * Vigencia de la inspección técnica (ITV) del vehículo OPERADO del conductor — gate de aprobación.
   * `id` = User.id (Vehicle.driverId, NO el driverId de perfil). Regla: el vehículo OPERADO del conductor
   * (`pickActiveVehicle`: selector AUTORITATIVO ÚNICO — el MISMO que expone GetDriverActiveVehicle, que
   * dispatch consume al adjudicar, y que el driver-bff sella en el ping vía `/drivers/vehicles/active`)
   * debe tener una inspección VIGENTE (última `passed && nextDueAt > now`). Sin vehículo operable → no
   * vigente (NO_VEHICLE). Devuelve datos útiles (vehicleId, plate, nextDueAt, motivo) para un error claro
   * en admin-bff. Solo LEE (read replica).
   */
  @GrpcMethod('FleetService', 'GetDriverInspectionStatus')
  async getDriverInspectionStatus(
    { id }: GetByIdRequest,
    metadata: Metadata,
  ): Promise<DriverInspectionStatusReply> {
    this.requireIdentity(metadata);
    const now = new Date();
    const vehicles = await this.prisma.read.vehicle.findMany({ where: { driverId: id } });
    const active = pickActiveVehicle(vehicles);
    if (!active) {
      // Sin vehículo operable (ninguno registrado, o todos con docs vencidos): no puede operar.
      return {
        current: false,
        hasVehicle: false,
        vehicleId: '',
        plate: '',
        nextDueAt: '',
        passed: false,
        invalidReason: NO_VEHICLE_REASON,
      };
    }

    // Última inspección del vehículo operado (orderBy inspectedAt desc, take 1 = la VIGENTE candidata).
    const latest = await this.prisma.read.inspection.findFirst({
      where: { vehicleId: active.id },
      orderBy: { inspectedAt: 'desc' },
    });
    const current = isInspectionCurrent(latest, now);
    const reason = current ? null : (inspectionInvalidReason(latest, now) ?? InspectionInvalidReason.NONE);

    return {
      current,
      hasVehicle: true,
      vehicleId: active.id,
      plate: active.plate,
      nextDueAt: latest ? latest.nextDueAt.toISOString() : '',
      passed: latest?.passed ?? false,
      invalidReason: reason ?? '',
    };
  }
}
