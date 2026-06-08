/**
 * Tipos de las respuestas gRPC de los microservicios (campos en camelCase porque el cliente
 * carga los .proto con keepCase:false). Reflejan los mensajes de @veo/rpc/proto/*.proto.
 */

export interface UserReply {
  id: string;
  phone: string;
  type: string;
  kycStatus: string;
  deleted: boolean;
  found: boolean;
}

export interface DriverReply {
  id: string;
  userId: string;
  currentStatus: string;
  backgroundCheckStatus: string;
  averageRating: number;
  found: boolean;
}

export interface TripReply {
  id: string;
  passengerId: string;
  driverId: string;
  vehicleId: string;
  status: string;
  fareCents: number;
  currency: string;
  distanceMeters: number;
  durationSeconds: number;
  paymentMethod: string;
  childMode: boolean;
  penaltyCents: number;
  found: boolean;
}

export interface TripStateReply {
  id: string;
  status: string;
  found: boolean;
}

export interface MatchReply {
  id: string;
  tripId: string;
  driverId: string;
  score: number;
  attempt: number;
  surgeMultiplier: number;
  outcome: string;
  offeredAt: string;
  respondedAt: string;
  found: boolean;
}

export interface SurgeReply {
  multiplier: number;
  zoneId: string;
  active: boolean;
}

export interface PaymentReply {
  id: string;
  tripId: string;
  method: string;
  status: string;
  amountCents: number;
  grossCents: number;
  commissionCents: number;
  feeCents: number;
  externalRef: string;
  found: boolean;
}

export interface AggregateReply {
  subjectId: string;
  role: string;
  rollingAvg30d: number;
  count30d: number;
  flagged: boolean;
  flagReason: string;
  lastComputedAt: string;
  found: boolean;
}

export interface VehicleReply {
  id: string;
  plate: string;
  make: string;
  model: string;
  year: number;
  color: string;
  /** Tipo de vehículo (CAR|MOTO) — Ola 2B. */
  vehicleType: string;
  docStatus: string;
  /** Estado de revisión del onboarding (PENDING_REVIEW|ACTIVE). */
  status: string;
  active: boolean;
  found: boolean;
}

export interface DriverVehiclesReply {
  driverId: string;
  vehicles: VehicleReply[];
}

export interface FleetDocumentReply {
  id: string;
  ownerType: string;
  ownerId: string;
  type: string;
  documentNumber: string;
  status: string;
  expiresAt: string;
}

export interface DriverDocumentsReply {
  driverId: string;
  documents: FleetDocumentReply[];
}

export interface NotificationReply {
  id: string;
  status: string;
  deduped: boolean;
  found: boolean;
}
