/**
 * Agregador puro del perfil del conductor. Sin I/O: combina las respuestas gRPC de
 * identity (driver+user), rating (agregado) y fleet (documentos) en una vista de cumplimiento.
 * Aislado del service para poder testearlo directamente.
 */
import { FleetDocumentStatus, FleetDocumentType } from '@veo/shared-types';
import type {
  AggregateReply,
  DriverDocumentsReply,
  DriverReply,
  UserReply,
  VehicleReply,
} from '../common/grpc-replies';
import type {
  DriverDocumentDetail,
  DriverDocumentSimpleStatus,
  DriverDocumentView,
  DriverProfileView,
  DriverVehicleView,
} from './dto/drivers.dto';
import type { FleetDocumentReply } from '../common/grpc-replies';

/** Tipos de documento exigidos al conductor para operar (FOUNDATION §14). */
export const REQUIRED_DRIVER_DOCS: string[] = [
  FleetDocumentType.LICENSE_A1,
  FleetDocumentType.SOAT,
  FleetDocumentType.PROPERTY_CARD,
  FleetDocumentType.BACKGROUND_CHECK,
  FleetDocumentType.ITV,
];

/** Un documento está vigente si está VALID o por vencer (EXPIRING_SOON). */
function isDocOk(status: string): boolean {
  return status === FleetDocumentStatus.VALID || status === FleetDocumentStatus.EXPIRING_SOON;
}

function emptyToNull(value: string): string | null {
  return value ? value : null;
}

/**
 * Mapea el estado crudo de fleet (VALID/EXPIRING_SOON/EXPIRED/PENDING_REVIEW/REJECTED) al estado
 * simple que muestra la app del conductor (vigente/por_vencer/vencido/en_revision/rechazado).
 */
export function toSimpleDocStatus(status: string): DriverDocumentSimpleStatus {
  switch (status) {
    case FleetDocumentStatus.VALID:
      return 'vigente';
    case FleetDocumentStatus.EXPIRING_SOON:
      return 'por_vencer';
    case FleetDocumentStatus.EXPIRED:
      return 'vencido';
    case FleetDocumentStatus.REJECTED:
      return 'rechazado';
    default:
      // PENDING_REVIEW (o cualquier estado desconocido) → en revisión.
      return 'en_revision';
  }
}

/** Vista detallada de un documento del conductor. */
export function buildDriverDocument(d: FleetDocumentReply): DriverDocumentDetail {
  return {
    type: d.type,
    documentNumber: emptyToNull(d.documentNumber) ?? '',
    status: d.status,
    simpleStatus: toSimpleDocStatus(d.status),
    expiresAt: emptyToNull(d.expiresAt),
    ok: isDocOk(d.status),
  };
}

/** Vista detallada de los documentos del conductor (GET /drivers/me/documents). */
export function buildDriverDocuments(docs: FleetDocumentReply[]): DriverDocumentDetail[] {
  return docs.map(buildDriverDocument);
}

/**
 * Respuesta REST del alta self-service de fleet (POST /api/v1/drivers/vehicles). Subconjunto del
 * vehículo + estado de revisión derivado. Se declara aquí para no acoplar al fleet-service.
 */
export interface FleetDriverVehicleReply {
  id: string;
  plate: string;
  make: string;
  model: string;
  year: number;
  vehicleType: string;
  docStatus: string;
  status: string;
}

/** Mapea el alta REST de fleet a la vista del vehículo del conductor (mapeo explícito). */
export function buildDriverVehicleFromRest(v: FleetDriverVehicleReply): DriverVehicleView {
  return {
    id: v.id,
    plate: v.plate,
    make: v.make,
    model: v.model,
    year: v.year,
    vehicleType: v.vehicleType,
    status: v.status,
    docStatus: v.docStatus,
  };
}

/** Mapea un VehicleReply (gRPC GetDriverVehicles) a la vista del vehículo del conductor. */
export function buildDriverVehicleFromGrpc(v: VehicleReply): DriverVehicleView {
  return {
    id: v.id,
    plate: v.plate,
    make: v.make,
    model: v.model,
    year: v.year,
    vehicleType: v.vehicleType,
    status: v.status,
    docStatus: v.docStatus,
  };
}

/** Mapea la lista de vehículos del conductor (GET /drivers/vehicles). */
export function buildDriverVehicles(vehicles: VehicleReply[]): DriverVehicleView[] {
  return vehicles.map(buildDriverVehicleFromGrpc);
}

export function buildDriverProfile(
  driver: DriverReply,
  user: UserReply,
  aggregate: AggregateReply,
  docs: DriverDocumentsReply,
): DriverProfileView {
  const documents: DriverDocumentView[] = (docs.documents ?? []).map((d) => ({
    type: d.type,
    status: d.status,
    expiresAt: emptyToNull(d.expiresAt),
    ok: isDocOk(d.status),
  }));

  const missing = REQUIRED_DRIVER_DOCS.filter(
    (type) => !documents.some((d) => d.type === type && d.ok),
  );

  return {
    driverId: driver.id,
    userId: driver.userId,
    phone: user.found ? user.phone : '',
    kycStatus: user.found ? user.kycStatus : '',
    currentStatus: driver.currentStatus,
    backgroundCheckStatus: driver.backgroundCheckStatus,
    averageRating: driver.averageRating,
    rating: aggregate.found
      ? {
          rollingAvg30d: aggregate.rollingAvg30d,
          count30d: aggregate.count30d,
          flagged: aggregate.flagged,
          flagReason: emptyToNull(aggregate.flagReason),
        }
      : null,
    documents,
    compliance: {
      compliant: missing.length === 0,
      requiredTypes: REQUIRED_DRIVER_DOCS,
      missing,
    },
  };
}
