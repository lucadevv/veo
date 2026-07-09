/**
 * Eventos de dominio de fleet-service (FOUNDATION §6).
 *
 * Convención de naming: `dominio.snake_case` (UN punto; el topic Kafka = dominio antes del punto → "fleet").
 * Estos eventType están registrados en `@veo/events` (EVENT_SCHEMAS) con guion bajo, así que el producer
 * VALIDA el payload al publicar y los consumidores (identity, admin-bff) casan por el MISMO string.
 * (Antes usaban puntos `fleet.driver.suspended` y NO casaban con el registro → admin-bff nunca recibía la
 * suspensión y los eventos viajaban sin validar. Alineado al guion bajo.)
 */
import { createEnvelope, type EventEnvelope } from '@veo/events';

export const FLEET_PRODUCER = 'fleet-service';

export const FleetEventType = {
  DOCUMENT_EXPIRING: 'fleet.document_expiring',
  DOCUMENT_EXPIRED: 'fleet.document_expired',
  DOCUMENT_REJECTED: 'fleet.document_rejected',
  DRIVER_SUSPENDED: 'fleet.driver_suspended',
  DRIVER_REACTIVATED: 'fleet.driver_reactivated',
  VEHICLE_SUSPENDED: 'fleet.vehicle_suspended',
  VEHICLE_REGISTERED: 'fleet.vehicle_registered',
  VEHICLE_MODEL_REVIEWED: 'fleet.vehicle_model_reviewed',
} as const;
export type FleetEventType = (typeof FleetEventType)[keyof typeof FleetEventType];

export interface DocumentExpiringPayload {
  documentId: string;
  ownerType: 'DRIVER' | 'VEHICLE';
  ownerId: string;
  documentType: string;
  expiresAt: string;
  daysRemaining: number;
  /** Hito de alerta alcanzado (30/15/7/1). */
  milestone: number;
}

export interface DocumentExpiredPayload {
  documentId: string;
  ownerType: 'DRIVER' | 'VEHICLE';
  ownerId: string;
  documentType: string;
  expiresAt: string;
  critical: boolean;
}

/**
 * El operador RECHAZÓ un documento del conductor (reviewDocument, decision=REJECTED). Downstream: notification
 * (push al conductor para que corrija y reenvíe) + audit (traza inmutable de la decisión). Cierra la asimetría
 * con el rechazo del ALTA (driver.rejected), que sí avisaba. `ownerId` = Driver.id de PERFIL (doc DRIVER-scoped,
 * como en la suspensión por documento). El `reason` (texto libre) NO viaja: data-minimization §0.7 (ningún
 * consumer lo usa — la app lo lee de la fila FleetDocument vía GET /drivers/me/documents; el audit excluye free-text).
 */
export interface DocumentRejectedPayload {
  documentId: string;
  ownerType: 'DRIVER' | 'VEHICLE';
  ownerId: string;
  documentType: string;
  rejectedAt: string;
}

/**
 * Suspensión AUTOMÁTICA de un conductor por compliance. El SUJETO viaja por UNA de dos claves, según el
 * origen (el consumer de identity exige exactamente una):
 *  - `driverId` (id de PERFIL Driver) → por DOCUMENTO crítico vencido. fleet lo conoce porque el
 *    `FleetDocument.ownerId` de un doc DRIVER-scoped ES el id de perfil.
 *  - `userId` (User.id = `Vehicle.driverId`) → por INSPECCIÓN técnica (ITV) vencida. fleet SOLO tiene el
 *    User.id del dueño del vehículo (no traduce a id de perfil): identity resuelve User.id → Driver.id en
 *    SU consumer. NUNCA mandamos un User.id en el campo `driverId` (ese era el bug a evitar: suspender al
 *    conductor equivocado por confundir User.id con Driver.id de perfil).
 */
export interface DriverSuspendedPayload {
  driverId?: string;
  userId?: string;
  reason: string;
  documentId?: string;
  documentType?: string;
  /** Trazabilidad de la suspensión por ITV (ausentes en la suspensión por documento). */
  vehicleId?: string;
  inspectionId?: string;
  nextDueAt?: string;
  /**
   * DISCRIMINADOR EXPLÍCITO de la causa (ADR 013 · seam catálogo↔operabilidad). AUSENTE en las vías históricas
   * (identity rutea por la clave: driverId→DOCUMENT_EXPIRED · userId→INSPECTION_EXPIRED). 'CATEGORY_DISABLED' →
   * el admin apagó del catálogo la última oferta de la CLASE del conductor: se emite por `userId` (=Vehicle.driverId)
   * e identity materializa un hold CATEGORY_DISABLED (no INSPECTION_EXPIRED, la otra vía por userId).
   */
  holdCause?: 'CATEGORY_DISABLED';
  suspendedAt: string;
}

/**
 * AUTO-reactivación de un conductor por compliance (INVERSA de DriverSuspendedPayload): el conductor
 * REGULARIZÓ lo que lo tenía suspendido por DOCUMENT_EXPIRED. El SUJETO viaja por UNA de dos claves, según
 * el origen (el consumer de identity exige exactamente una, espejo de la suspensión):
 *  - `userId` (User.id = `Vehicle.driverId`) → se registró una INSPECCIÓN técnica (ITV) NUEVA y VIGENTE.
 *    fleet SOLO tiene el User.id; identity resuelve User.id → Driver.id en SU consumer.
 *  - `driverId` (id de PERFIL Driver) → un DOCUMENTO crítico DRIVER-scoped volvió a VALID. fleet lo conoce
 *    porque `FleetDocument.ownerId` de un doc DRIVER-scoped ES el id de perfil.
 * NUNCA mandamos un User.id en `driverId` (mismo filo que la suspensión: confundirlos reactivaría al
 * conductor equivocado). identity reactiva SOLO suspensiones DOCUMENT_EXPIRED (una DISCIPLINARY queda intacta).
 */
export interface DriverReactivatedPayload {
  driverId?: string;
  userId?: string;
  reason: string;
  /** Trazabilidad de la reactivación por ITV (ausentes en la reactivación por documento). */
  vehicleId?: string;
  inspectionId?: string;
  nextDueAt?: string;
  /** Trazabilidad de la reactivación por documento (ausentes en la reactivación por ITV). */
  documentId?: string;
  documentType?: string;
  /** Espejo del discriminador de la suspensión: 'CATEGORY_DISABLED' → la clase volvió a ser operable (el admin
   *  re-activó la oferta). Se emite por `userId` e identity quita SOLO el hold CATEGORY_DISABLED. */
  holdCause?: 'CATEGORY_DISABLED';
  reactivatedAt: string;
}

export interface VehicleSuspendedPayload {
  vehicleId: string;
  reason: string;
  suspendedAt: string;
}

/** Alta self-service de un vehículo por el conductor (onboarding). Queda pendiente de verificación. */
export interface VehicleRegisteredPayload {
  vehicleId: string;
  driverId: string;
  plate: string;
  vehicleType: 'CAR' | 'MOTO';
  registeredAt: string;
}

/**
 * El operador APRUEBA o RECHAZA un modelo de vehículo solicitado por un conductor. El veredicto viaja
 * al conductor (`requestedBy`) como push. `verdict` es el estado FINAL de la transición, tipado al enum
 * del contrato — no un string suelto.
 */
export interface VehicleModelReviewedPayload {
  modelId: string;
  requestedBy: string;
  verdict: 'APPROVED' | 'REJECTED';
  make: string;
  model: string;
  reviewedAt: string;
}

type FleetPayload =
  | DocumentExpiringPayload
  | DocumentExpiredPayload
  | DocumentRejectedPayload
  | DriverSuspendedPayload
  | DriverReactivatedPayload
  | VehicleSuspendedPayload
  | VehicleRegisteredPayload
  | VehicleModelReviewedPayload;

/** Construye el envelope de un evento de fleet listo para encolar en el outbox. */
export function buildFleetEvent<T extends FleetPayload>(
  eventType: FleetEventType,
  payload: T,
): EventEnvelope<T> {
  return createEnvelope<T>({ eventType, producer: FLEET_PRODUCER, payload });
}
