/**
 * FleetService — flota y compliance documental: vehículos, documentos, inspecciones y vencimientos.
 * Lecturas/comandos vía REST interno firmado a fleet-service. Documentos se mapean a fleetDocumentView.
 */
import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InternalRestClient,
  type GrpcServiceClient,
  type UsersByIdsReply,
  type VehiclesInspectionStatusReply,
} from '@veo/rpc';
import {
  grpcIdentityMetadata,
  INTERNAL_IDENTITY_AUDIENCE,
  type AuthenticatedUser,
  type InternalAudience,
} from '@veo/auth';
import { VehicleOperabilityReason } from '@veo/shared-types';
import { canSeeIdentity } from '../redaction/redaction.policy';
import { GRPC_IDENTITY, GRPC_FLEET } from '../infra/tokens';
import type { Env } from '../config/env.schema';
import type {
  ExpiringDocumentView,
  FleetDocumentView,
  InspectionView,
  VehicleModelReviewView,
  VehicleModelSpecView,
  VehicleView,
} from '@veo/api-client';
import { REST_FLEET } from '../infra/tokens';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type {
  CreateVehicleDto,
  CreateDocumentDto,
  ReviewDocumentDto,
  CreateInspectionDto,
  ListVehiclesQueryDto,
  ListDocumentsQueryDto,
  ListInspectionsQueryDto,
  ListModelReviewQueryDto,
  ListVehicleModelsQueryDto,
  ApproveVehicleModelDto,
  ExpirationsQueryDto,
} from './dto/fleet.dto';

/** Página con cursor que devuelve fleet-service; misma forma que `paginated()` del contrato admin-web. */
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

interface Vehicle {
  id: string;
  plate: string;
  make: string;
  model: string;
  year: number;
  color: string;
  docStatus: string;
  active: boolean;
  // Operabilidad DERIVADA (Lote 4): el MISMO veredicto que gatea el match (docs SOAT/ITV operables Y ficha
  // linkeada Y docStatus !== EXPIRED). El panel la MUESTRA en vez del flag `active` stored (DEPRECADO, nada lo
  // mantiene). `operabilityReason` dice el PORQUÉ cuando no opera (DOCS/NO_SPEC), null si opera. Opcional por
  // compat: un fleet-service viejo no los envía → degradamos a no-operable + motivo DOCS (dirección segura).
  operable?: boolean;
  operabilityReason?: VehicleOperabilityReason | null;
  driverId: string | null;
  // Ficha técnica del MATCH (fleet-service la enriquece desde el modelSpec; ver VehicleListItem). Opcional/nullable
  // por compat: un fleet-service viejo no la envía → el panel degrada a "—" (nunca rompe).
  vehicleType?: string | null;
  mtcCategory?: string | null;
  segment?: string | null;
  energySource?: string | null;
  efficiency?: number | null;
  seats?: number | null;
}
/** Shape interno que sirve fleet-service (REST /documents). `status` ES el enum Prisma
 *  `FleetDocumentStatus` serializado tal cual (sin transformación intermedia); el contrato
 *  `fleetDocumentStatus` lo espeja 1:1 — mismo endurecimiento que `Payout.status` en finance. */
interface FleetDocument {
  id: string;
  ownerType: 'DRIVER' | 'VEHICLE';
  ownerId: string;
  type: string;
  status: FleetDocumentView['status'];
  expiresAt: string | null;
}
interface Inspection {
  id: string;
  vehicleId: string;
  inspectorId: string;
  passed: boolean;
  inspectedAt: string;
}

@Injectable()
export class FleetService {
  private readonly secret: string;
  constructor(
    @Inject(REST_FLEET) private readonly rest: InternalRestClient,
    @Inject(GRPC_IDENTITY) private readonly identityGrpc: GrpcServiceClient,
    @Inject(GRPC_FLEET) private readonly fleetGrpc: GrpcServiceClient,
    @Inject(INTERNAL_IDENTITY_AUDIENCE) private readonly audience: InternalAudience,
    config: ConfigService<Env, true>,
    private readonly audit: AuditRecorder,
  ) {
    this.secret = config.get('VEO_INTERNAL_IDENTITY_SECRET', { infer: true });
  }

  /**
   * Enriquece los vehículos (lista o detalle) con NOMBRE del conductor (User.id → name · Compliance+) e ITV
   * (última inspección por vehículo). DOS batches gRPC EN PARALELO (anti-N+1): identity GetUsersByIds + fleet
   * GetVehiclesInspectionStatus. El nombre se redacta a null para sub-Compliance (misma política que drivers).
   */
  private async enrichVehicles(
    identity: AuthenticatedUser,
    vehicles: Vehicle[],
  ): Promise<VehicleView[]> {
    if (vehicles.length === 0) return [];
    const meta = grpcIdentityMetadata(identity, this.secret, this.audience);
    const driverIds = [
      ...new Set(vehicles.map((v) => v.driverId).filter((x): x is string => !!x)),
    ];
    const vehicleIds = vehicles.map((v) => v.id);
    const [usersReply, itvReply] = await Promise.all([
      driverIds.length > 0
        ? this.identityGrpc.call<UsersByIdsReply>('GetUsersByIds', { ids: driverIds }, meta)
        : Promise.resolve<UsersByIdsReply>({ users: [] }),
      this.fleetGrpc.call<VehiclesInspectionStatusReply>(
        'GetVehiclesInspectionStatus',
        { ids: vehicleIds },
        meta,
      ),
    ]);
    const identityVisible = canSeeIdentity(identity.roles);
    const nameById = new Map(usersReply.users.map((u) => [u.id, u.name]));
    const itvById = new Map(itvReply.items.map((it) => [it.vehicleId, it]));
    return vehicles.map((v) =>
      toVehicleView(v, {
        driverName: identityVisible && v.driverId ? nameById.get(v.driverId) || null : null,
        itv: itvById.get(v.id) ?? null,
      }),
    );
  }

  async createVehicle(identity: AuthenticatedUser, dto: CreateVehicleDto): Promise<Vehicle> {
    const v = await this.rest.post<Vehicle>('/vehicles', { identity, body: dto });
    await this.audit.record(identity, {
      action: 'vehicle.create',
      resourceType: 'vehicle',
      resourceId: v.id,
      payload: { plate: dto.plate },
    });
    return v;
  }

  /** Detalle de UN vehículo. Proxy a fleet-service + proyección a vehicleView del contrato — la MISMA forma
   * que devuelve la lista (antes devolvía el Vehicle crudo, así el detalle era ciego a la ficha del match). */
  async getVehicle(identity: AuthenticatedUser, id: string): Promise<VehicleView> {
    const v = await this.rest.get<Vehicle>(`/vehicles/${id}`, { identity });
    const [view] = await this.enrichVehicles(identity, [v]);
    // enrichVehicles mapea 1:1 → [v] siempre da un item; el fallback (sin enriquecer) es defensa TS, no ocurre.
    return view ?? toVehicleView(v);
  }

  /** Lista paginada de la flota (admin). Proxy a fleet-service + enriquecimiento (nombre + ITV) + proyección. */
  async listVehicles(
    identity: AuthenticatedUser,
    query: ListVehiclesQueryDto,
  ): Promise<Page<VehicleView>> {
    const page = await this.rest.get<Page<Vehicle>>('/vehicles', {
      identity,
      query: { docStatus: query.status, cursor: query.cursor, limit: query.limit },
    });
    return { items: await this.enrichVehicles(identity, page.items), nextCursor: page.nextCursor };
  }

  /** Lista paginada de documentos (admin), filtrable por estado. Proyección a fleetDocumentView. */
  async listDocuments(
    identity: AuthenticatedUser,
    query: ListDocumentsQueryDto,
  ): Promise<Page<FleetDocumentView>> {
    const page = await this.rest.get<Page<FleetDocument>>('/documents', {
      identity,
      query: {
        status: query.status,
        ownerId: query.ownerId,
        cursor: query.cursor,
        limit: query.limit,
      },
    });
    return { items: page.items.map(toFleetDocumentView), nextCursor: page.nextCursor };
  }

  /** Lista paginada de inspecciones (admin), filtro opcional por vehículo. Proyección a inspectionView. */
  async listInspections(
    identity: AuthenticatedUser,
    query: ListInspectionsQueryDto,
  ): Promise<Page<InspectionView>> {
    const page = await this.rest.get<Page<Inspection>>('/inspections', {
      identity,
      query: { vehicleId: query.vehicleId, cursor: query.cursor, limit: query.limit },
    });
    return { items: page.items.map(toInspectionView), nextCursor: page.nextCursor };
  }

  async createDocument(
    identity: AuthenticatedUser,
    dto: CreateDocumentDto,
  ): Promise<FleetDocumentView> {
    const doc = await this.rest.post<FleetDocument>('/documents', { identity, body: dto });
    await this.audit.record(identity, {
      action: 'document.create',
      resourceType: 'fleet_document',
      resourceId: doc.id,
      payload: { ownerType: dto.ownerType, ownerId: dto.ownerId, type: dto.type },
    });
    return toFleetDocumentView(doc);
  }

  async reviewDocument(
    identity: AuthenticatedUser,
    id: string,
    dto: ReviewDocumentDto,
  ): Promise<FleetDocumentView> {
    const doc = await this.rest.post<FleetDocument>(`/documents/${id}/review`, {
      identity,
      // M5: el motivo del rechazo viaja a fleet (lo persiste y el conductor lo ve). Sin motivo ⇒ se omite.
      body: dto.reason ? { decision: dto.decision, reason: dto.reason } : { decision: dto.decision },
    });
    await this.audit.record(identity, {
      action: 'document.review',
      resourceType: 'fleet_document',
      resourceId: id,
      payload: dto.reason ? { decision: dto.decision, reason: dto.reason } : { decision: dto.decision },
    });
    return toFleetDocumentView(doc);
  }

  async createInspection(
    identity: AuthenticatedUser,
    dto: CreateInspectionDto,
  ): Promise<Inspection> {
    const ins = await this.rest.post<Inspection>('/inspections', { identity, body: dto });
    await this.audit.record(identity, {
      action: 'inspection.create',
      resourceType: 'inspection',
      resourceId: ins.id,
      payload: { vehicleId: dto.vehicleId, passed: dto.passed },
    });
    return ins;
  }

  /**
   * Cola de vencimientos PAGINADA (cursor compuesto que sirve fleet-service). Proxy a fleet
   * GET /fleet/expirations + proyección a expiringDocumentView. Reemplaza el contrato ARRAY previo
   * (cap silencioso de 25): ahora el operador puede recorrer TODA la cola siguiendo `nextCursor`.
   *
   * FILTRO POST-MAP (decisión documentada): `toExpiringDocumentView` descarta docs sin `expiresAt`. El
   * filtro corre DESPUÉS de paginar, así que una página PUEDE quedar con menos items que `limit` — está
   * bien. El `nextCursor` lo decide fleet-service sobre su última fila DEVUELTA (antes del filtro del
   * BFF), por lo que el avance del cursor NO se rompe: descartar items en el BFF no saltea ni duplica
   * filas, solo achica la página visible. En la práctica el branch within-days ya filtra `expiresAt not
   * null` en fleet, así que el descarte solo puede ocurrir en el branch sin `days` (EXPIRING_SOON/EXPIRED
   * con expiresAt null, caso degenerado).
   */
  async expirations(
    identity: AuthenticatedUser,
    query: ExpirationsQueryDto,
  ): Promise<Page<ExpiringDocumentView>> {
    const page = await this.rest.get<Page<FleetDocument>>('/fleet/expirations', {
      identity,
      query: { days: query.days, cursor: query.cursor, limit: query.limit },
    });
    const items = page.items
      .map(toExpiringDocumentView)
      .filter((d): d is ExpiringDocumentView => d !== null);
    return { items, nextCursor: page.nextCursor };
  }

  /**
   * Cola de revisión del catálogo de modelos (B5-2.c): solicitudes de los conductores a curar. Proxy a
   * fleet GET /vehicle-models/review. La forma del review espeja 1:1 el contrato vehicleModelReviewView.
   */
  listModelReview(
    identity: AuthenticatedUser,
    query: ListModelReviewQueryDto,
  ): Promise<Page<VehicleModelReviewView>> {
    return this.rest.get<Page<VehicleModelReviewView>>('/vehicle-models/review', {
      identity,
      query: { status: query.status, cursor: query.cursor, limit: query.limit },
    });
  }

  /**
   * Catálogo APROBADO de modelos para el selector del alta admin (F4 · C2). Proxy a fleet GET
   * /vehicle-models (listApproved). La forma espeja 1:1 el contrato vehicleModelSpecView; el selector elige
   * y manda el modelSpecId al crear el vehículo (fleet snapshotea make/model/tipo, server-authoritative).
   */
  listModels(
    identity: AuthenticatedUser,
    query: ListVehicleModelsQueryDto,
  ): Promise<Page<VehicleModelSpecView>> {
    return this.rest.get<Page<VehicleModelSpecView>>('/vehicle-models', {
      identity,
      query: {
        vehicleType: query.vehicleType,
        q: query.q,
        cursor: query.cursor,
        limit: query.limit,
      },
    });
  }

  /** Aprueba una solicitud completando la ficha técnica → fleet PUT /vehicle-models/:id/approve + audit. */
  async approveModel(
    identity: AuthenticatedUser,
    id: string,
    dto: ApproveVehicleModelDto,
  ): Promise<VehicleModelReviewView> {
    const model = await this.rest.put<VehicleModelReviewView>(`/vehicle-models/${id}/approve`, {
      identity,
      body: dto,
    });
    await this.audit.record(identity, {
      action: 'vehicle_model.approve',
      resourceType: 'vehicle_model',
      resourceId: id,
      payload: { segment: dto.segment, energySource: dto.energySource, efficiency: dto.efficiency },
    });
    return model;
  }

  /** Reabre un modelo APROBADO para corregir su ficha → fleet PUT /vehicle-models/:id/reopen + audit (F2). */
  async reopenModel(identity: AuthenticatedUser, id: string): Promise<VehicleModelReviewView> {
    const model = await this.rest.put<VehicleModelReviewView>(`/vehicle-models/${id}/reopen`, {
      identity,
      body: {},
    });
    await this.audit.record(identity, {
      action: 'vehicle_model.reopen',
      resourceType: 'vehicle_model',
      resourceId: id,
    });
    return model;
  }

  /** Rechaza una solicitud → fleet PUT /vehicle-models/:id/reject + audit. */
  async rejectModel(identity: AuthenticatedUser, id: string): Promise<VehicleModelReviewView> {
    const model = await this.rest.put<VehicleModelReviewView>(`/vehicle-models/${id}/reject`, {
      identity,
      body: {},
    });
    await this.audit.record(identity, {
      action: 'vehicle_model.reject',
      resourceType: 'vehicle_model',
      resourceId: id,
    });
    return model;
  }
}

function toFleetDocumentView(d: FleetDocument): FleetDocumentView {
  return {
    id: d.id,
    ownerType: d.ownerType,
    ownerId: d.ownerId,
    type: d.type,
    status: d.status,
    expiresAt: d.expiresAt ?? null,
  };
}

function toVehicleView(
  v: Vehicle,
  enrich?: {
    driverName: string | null;
    itv: { hasInspection: boolean; current: boolean; nextDueAt: string } | null;
  },
): VehicleView {
  return {
    id: v.id,
    plate: v.plate,
    brand: v.make,
    model: v.model,
    year: v.year,
    color: v.color,
    status: v.docStatus,
    // Nombre del conductor dueño (User.id → name · Compliance+; null redactado o sin dato). Reemplaza el id
    // truncado del panel viejo. El estado de ITV (última inspección) alimenta la columna "ITV" del frame.
    driverName: enrich?.driverName ?? null,
    itvHasInspection: enrich?.itv?.hasInspection ?? false,
    itvCurrent: enrich?.itv?.current ?? false,
    itvNextDueAt: enrich?.itv?.nextDueAt || null,
    // Veredicto de operabilidad + motivo (Lote 4): el panel los MUESTRA para coincidir con el backend del match.
    // Un fleet-service viejo que no los envía → no-operable + motivo DOCS (degradación segura, no sobre-reporta).
    operable: v.operable ?? false,
    operabilityReason:
      v.operable === undefined
        ? VehicleOperabilityReason.DOCS
        : (v.operabilityReason ?? null),
    driverId: v.driverId ?? null,
    // Ficha técnica del match (degradación honesta: un fleet-service que aún no la envía → null → "—" en el panel).
    vehicleType: v.vehicleType ?? null,
    mtcCategory: v.mtcCategory ?? null,
    segment: v.segment ?? null,
    energySource: v.energySource ?? null,
    efficiency: v.efficiency ?? null,
    seats: v.seats ?? null,
  };
}

function toInspectionView(i: Inspection): InspectionView {
  // fleet-service solo registra inspecciones ya realizadas → status COMPLETED; el veredicto va en `result`.
  return {
    id: i.id,
    vehicleId: i.vehicleId,
    status: 'COMPLETED',
    inspectedAt: i.inspectedAt,
    scheduledAt: null,
    inspector: i.inspectorId,
    result: i.passed ? 'PASSED' : 'FAILED',
  };
}

/** Proyecta a expiringDocumentView calculando los días hasta el vencimiento. Descarta docs sin expiresAt. */
function toExpiringDocumentView(d: FleetDocument): ExpiringDocumentView | null {
  if (!d.expiresAt) return null;
  const msPerDay = 86_400_000;
  const daysUntilExpiry = Math.floor((new Date(d.expiresAt).getTime() - Date.now()) / msPerDay);
  return {
    id: d.id,
    ownerType: d.ownerType,
    ownerId: d.ownerId,
    type: d.type,
    status: d.status,
    expiresAt: d.expiresAt,
    daysUntilExpiry,
  };
}
