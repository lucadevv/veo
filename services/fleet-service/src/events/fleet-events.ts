/**
 * Eventos de dominio de fleet-service (FOUNDATION §6).
 *
 * ⚠ Estos eventType AÚN NO están registrados en `@veo/events` (EVENT_SCHEMAS). Se publican vía
 * outbox: el producer sólo valida payloads de eventos registrados, así que estos viajan tal cual.
 * Quedan documentados en `docs/events.md` y reportados al orquestador para su registro formal
 * (topic Kafka = dominio antes del primer punto → "fleet").
 */
import { createEnvelope, type EventEnvelope } from '@veo/events';

export const FLEET_PRODUCER = 'fleet-service';

export const FleetEventType = {
  DOCUMENT_EXPIRING: 'fleet.document.expiring',
  DOCUMENT_EXPIRED: 'fleet.document.expired',
  DRIVER_SUSPENDED: 'fleet.driver.suspended',
  VEHICLE_SUSPENDED: 'fleet.vehicle.suspended',
  VEHICLE_REGISTERED: 'fleet.vehicle.registered',
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

type FleetPayload =
  | DocumentExpiringPayload
  | DocumentExpiredPayload
  | DriverSuspendedPayload
  | VehicleSuspendedPayload
  | VehicleRegisteredPayload;

/** Construye el envelope de un evento de fleet listo para encolar en el outbox. */
export function buildFleetEvent<T extends FleetPayload>(
  eventType: FleetEventType,
  payload: T,
): EventEnvelope<T> {
  return createEnvelope<T>({ eventType, producer: FLEET_PRODUCER, payload });
}
