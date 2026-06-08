/**
 * FleetService — flota y compliance documental: vehículos, documentos, inspecciones y vencimientos.
 * Lecturas/comandos vía REST interno firmado a fleet-service. Documentos se mapean a fleetDocumentView.
 */
import { Injectable, Inject } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type { FleetDocumentView } from '@veo/api-client';
import { REST_FLEET } from '../infra/tokens';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type {
  CreateVehicleDto,
  CreateDocumentDto,
  ReviewDocumentDto,
  CreateInspectionDto,
} from './dto/fleet.dto';

interface Vehicle {
  id: string;
  plate: string;
  make: string;
  model: string;
  year: number;
  color: string;
  docStatus: string;
  active: boolean;
}
interface FleetDocument {
  id: string;
  ownerType: 'DRIVER' | 'VEHICLE';
  ownerId: string;
  type: string;
  status: string;
  expiresAt: string | null;
}
interface Inspection {
  id: string;
  vehicleId: string;
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

  async listDocuments(identity: AuthenticatedUser, ownerId: string): Promise<FleetDocumentView[]> {
    const docs = await this.rest.get<FleetDocument[]>('/documents', { identity, query: { ownerId } });
    return docs.map(toFleetDocumentView);
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

  listInspections(identity: AuthenticatedUser, vehicleId: string): Promise<Inspection[]> {
    return this.rest.get<Inspection[]>('/inspections', { identity, query: { vehicleId } });
  }

  async expirations(identity: AuthenticatedUser, days?: number): Promise<FleetDocumentView[]> {
    const docs = await this.rest.get<FleetDocument[]>('/fleet/expirations', {
      identity,
      query: { days },
    });
    return docs.map(toFleetDocumentView);
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
