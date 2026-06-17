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
  DRIVER_SUSPENDED: 'fleet.driver_suspended',
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

export interface DriverSuspendedPayload {
  driverId: string;
  reason: string;
  documentId: string;
  documentType: string;
  suspendedAt: string;
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
  | DriverSuspendedPayload
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
