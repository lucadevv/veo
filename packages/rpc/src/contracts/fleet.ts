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

/**
 * fleet.GetVehiclesByIds / mensaje VehiclesReply. Lote 3b: lectura BATCH de vehículos por id (anti-N+1) para
 * el filtro de operabilidad de la BÚSQUEDA de carpooling. Trae un VehicleReply por cada id ENCONTRADO
 * (found=true); los ids inexistentes se omiten (el caller trata "ausente del map" como no-operable).
 */
export interface VehiclesReply {
  vehicles: VehicleReply[];
}

/** Imagen de un documento (sub-lote 3A · múltiples imágenes). `side` = FRONT|BACK|SINGLE (string del enum). */
export interface DocumentImageReply {
  s3Key: string;
  side: string;
  order: number;
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
  /** DEPRECADO (sub-lote 3A): primera imagen (backward-compat). Usar `images`. NO se proyecta al conductor. */
  fileS3Key: string;
  /** Interno (admin review). NO se proyecta al conductor; el driver-bff mapea un subconjunto explícito. */
  rejectionReason: string;
  /** Imágenes del documento (1..N caras). Admin review las firma; el driver-bff mapea un subconjunto. */
  images: DocumentImageReply[];
}

/** fleet.GetDriverDocuments / mensaje DriverDocumentsReply. */
export interface DriverDocumentsReply {
  driverId: string;
  documents: FleetDocumentReply[];
}

/**
 * fleet.GetDriverInspectionStatus / mensaje DriverInspectionStatusReply.
 * Vigencia de la ITV del vehículo OPERADO del conductor (gate de aprobación · compliance).
 * proto3 entrega ""/false por default (nunca null); `invalidReason` "" cuando current=true.
 */
export interface DriverInspectionStatusReply {
  current: boolean;
  hasVehicle: boolean;
  vehicleId: string;
  plate: string;
  nextDueAt: string;
  passed: boolean;
  /** NONE | NOT_PASSED | OVERDUE | NO_VEHICLE | "" (cuando current=true). */
  invalidReason: string;
}

/** fleet.GetVehicleCounts / VehicleCountsReply. Conteo de vehículos por docStatus (stat cards del admin). */
export interface VehicleCountsReply {
  valid: number;
  expiringSoon: number;
  expired: number;
}

/** fleet.GetReviewQueueCounts / ReviewQueueCountsReply. Conteo de las colas de revisión de flota. */
export interface ReviewQueueCountsReply {
  docsPendingReview: number;
  docsExpiringSoon: number;
  modelsPendingReview: number;
}
