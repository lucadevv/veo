/**
 * FleetService — flota y compliance documental: vehículos, documentos, inspecciones y vencimientos.
 * Lecturas/comandos vía REST interno firmado a fleet-service. Documentos se mapean a fleetDocumentView.
 */
import { Injectable, Inject } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type {
  ExpiringDocumentView,
  FleetDocumentView,
  InspectionView,
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
  driverId: string | null;
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
  constructor(
    @Inject(REST_FLEET) private readonly rest: InternalRestClient,
    private readonly audit: AuditRecorder,
  ) {}

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

  getVehicle(identity: AuthenticatedUser, id: string): Promise<Vehicle> {
    return this.rest.get<Vehicle>(`/vehicles/${id}`, { identity });
  }

  /** Lista paginada de la flota (admin). Proxy a fleet-service + proyección a vehicleView del contrato. */
  async listVehicles(identity: AuthenticatedUser, query: ListVehiclesQueryDto): Promise<Page<VehicleView>> {
    const page = await this.rest.get<Page<Vehicle>>('/vehicles', {
      identity,
      query: { docStatus: query.status, cursor: query.cursor, limit: query.limit },
    });
    return { items: page.items.map(toVehicleView), nextCursor: page.nextCursor };
  }

  /** Lista paginada de documentos (admin), filtrable por estado. Proyección a fleetDocumentView. */
  async listDocuments(identity: AuthenticatedUser, query: ListDocumentsQueryDto): Promise<Page<FleetDocumentView>> {
    const page = await this.rest.get<Page<FleetDocument>>('/documents', {
      identity,
      query: { status: query.status, ownerId: query.ownerId, cursor: query.cursor, limit: query.limit },
    });
    return { items: page.items.map(toFleetDocumentView), nextCursor: page.nextCursor };
  }

  /** Lista paginada de inspecciones (admin), filtro opcional por vehículo. Proyección a inspectionView. */
  async listInspections(identity: AuthenticatedUser, query: ListInspectionsQueryDto): Promise<Page<InspectionView>> {
    const page = await this.rest.get<Page<Inspection>>('/inspections', {
      identity,
      query: { vehicleId: query.vehicleId, cursor: query.cursor, limit: query.limit },
    });
    return { items: page.items.map(toInspectionView), nextCursor: page.nextCursor };
  }

  async createDocument(identity: AuthenticatedUser, dto: CreateDocumentDto): Promise<FleetDocumentView> {
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
      body: { decision: dto.decision },
    });
    await this.audit.record(identity, {
      action: 'document.review',
      resourceType: 'fleet_document',
      resourceId: id,
      payload: { decision: dto.decision },
    });
    return toFleetDocumentView(doc);
  }

  async createInspection(identity: AuthenticatedUser, dto: CreateInspectionDto): Promise<Inspection> {
    const ins = await this.rest.post<Inspection>('/inspections', { identity, body: dto });
    await this.audit.record(identity, {
      action: 'inspection.create',
      resourceType: 'inspection',
      resourceId: ins.id,
      payload: { vehicleId: dto.vehicleId, passed: dto.passed },
    });
    return ins;
  }

  async expirations(identity: AuthenticatedUser, days?: number): Promise<ExpiringDocumentView[]> {
    const docs = await this.rest.get<FleetDocument[]>('/fleet/expirations', {
      identity,
      query: { days },
    });
    return docs.map(toExpiringDocumentView).filter((d): d is ExpiringDocumentView => d !== null);
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

function toVehicleView(v: Vehicle): VehicleView {
  return {
    id: v.id,
    plate: v.plate,
    brand: v.make,
    model: v.model,
    year: v.year,
    color: v.color,
    status: v.docStatus,
    driverId: v.driverId ?? null,
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
