/**
 * Tipos wire de veo.fleet.v1 (proto/fleet.proto) — FUENTE ÚNICA para todos los consumidores.
 * Derivados a mano del .proto canónico con la semántica del loader de @veo/rpc
 * (keepCase:false → camelCase; defaults:true → proto3 entrega ""/0/false/[], nunca null).
 */

/** fleet.GetVehicle / mensaje VehicleReply. */
export interface VehicleReply {
  id: string;
  plate: string;
  make: string;
  model: string;
  year: number;
  color: string;
  docStatus: string;
  active: boolean;
  found: boolean;
  /** Tipo de vehículo (CAR|MOTO) — Ola 2B. */
  vehicleType: string;
  /** Estado de revisión del onboarding (PENDING_REVIEW|ACTIVE). */
  status: string;
}

/** fleet.GetDriverVehicles / mensaje DriverVehiclesReply. */
export interface DriverVehiclesReply {
  driverId: string;
  vehicles: VehicleReply[];
}

/** Documento de flota (de conductor o vehículo). */
export interface FleetDocumentReply {
  id: string;
  ownerType: string;
  ownerId: string;
  type: string;
  documentNumber: string;
  status: string;
  expiresAt: string;
  /** Interno (admin review). NO se proyecta al conductor; el driver-bff mapea un subconjunto explícito. */
  fileS3Key: string;
  /** Interno (admin review). NO se proyecta al conductor; el driver-bff mapea un subconjunto explícito. */
  rejectionReason: string;
}

/** fleet.GetDriverDocuments / mensaje DriverDocumentsReply. */
export interface DriverDocumentsReply {
  driverId: string;
  documents: FleetDocumentReply[];
}
