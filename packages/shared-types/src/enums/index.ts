export const TripStatus = {
  /**
   * Viaje PROGRAMADO (Ola 2B): creado con `scheduledFor` futuro. Aún NO está en dispatch.
   * El scheduler de trip-service lo transiciona a REQUESTED al acercarse la hora (lead time).
   */
  SCHEDULED: 'SCHEDULED',
  REQUESTED: 'REQUESTED',
  ASSIGNED: 'ASSIGNED',
  ACCEPTED: 'ACCEPTED',
  ARRIVING: 'ARRIVING',
  ARRIVED: 'ARRIVED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  /**
   * PUJA / reasignación (ADR 010 §3.1, decisión #4): el conductor canceló DESPUÉS de aceptar
   * (pre-recojo) y el viaje re-abre la puja en vez de quedar abandonado. NO es terminal: desde aquí
   * el viaje vuelve a ASSIGNED (re-match), EXPIRED (sin ofertas) o CANCELLED_BY_PASSENGER (el pasajero
   * se rinde). Cierra el catastrófico #4 (conductor cancela ACCEPTED → pasajero abandonado).
   */
  REASSIGNING: 'REASSIGNING',
  CANCELLED_BY_PASSENGER: 'CANCELLED_BY_PASSENGER',
  CANCELLED_BY_DRIVER: 'CANCELLED_BY_DRIVER',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
} as const;
export type TripStatus = (typeof TripStatus)[keyof typeof TripStatus];

export const PaymentMethod = {
  YAPE: 'YAPE',
  PLIN: 'PLIN',
  CASH: 'CASH',
  CARD: 'CARD',
  /// PagoEfectivo (ProntoPaga): el pasajero recibe un CIP y paga en efectivo en agente/banca.
  /// Cobro asíncrono → confirma por webhook (Ola pagos PE).
  PAGOEFECTIVO: 'PAGOEFECTIVO',
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const PaymentStatus = {
  PENDING: 'PENDING',
  CAPTURED: 'CAPTURED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  DEBT: 'DEBT',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const DriverStatus = {
  OFFLINE: 'OFFLINE',
  AVAILABLE: 'AVAILABLE',
  ASSIGNED: 'ASSIGNED',
  ON_TRIP: 'ON_TRIP',
  ON_BREAK: 'ON_BREAK',
  SUSPENDED: 'SUSPENDED',
} as const;
export type DriverStatus = (typeof DriverStatus)[keyof typeof DriverStatus];

/**
 * Tipo de vehículo (Ola 2B · tier moto-taxi). CAR = automóvil estándar (default histórico);
 * MOTO = mototaxi. El matching de dispatch filtra por este tipo: un viaje MOTO solo se ofrece a
 * conductores con vehículo MOTO. Modelado en fleet-service (Vehicle.vehicleType).
 */
export const VehicleType = {
  CAR: 'CAR',
  MOTO: 'MOTO',
} as const;
export type VehicleType = (typeof VehicleType)[keyof typeof VehicleType];

/**
 * Solicitud especial del pasajero al conductor (BE-2). El conductor las VE antes de aceptar la puja.
 * PET = mascota · LUGGAGE = equipaje · CHILD_SEAT = silla de niño. "Parada" NO va acá: es un waypoint
 * del trayecto. Viajan en trip.bid_posted → board → vista de puja del conductor.
 */
export const SpecialRequest = {
  PET: 'PET',
  LUGGAGE: 'LUGGAGE',
  CHILD_SEAT: 'CHILD_SEAT',
} as const;
export type SpecialRequest = (typeof SpecialRequest)[keyof typeof SpecialRequest];

/**
 * Modo de despacho/pricing del viaje (ADR 011). PUJA = "proponé tu precio" (marketplace de ofertas,
 * ADR 010); FIXED = tarifa fija calculada estilo Uber (BR-T05). El ADMIN decide el modo por horario
 * (schedule global, Tier 1); el SERVIDOR lo resuelve UNA vez en createTrip y lo CONGELA en
 * Trip.dispatchMode (regla de oro resolve-once-persist-forever). Default del sistema: PUJA (VEO es
 * puja; el fijo es la excepción programada).
 */
export const PricingMode = {
  PUJA: 'PUJA',
  FIXED: 'FIXED',
} as const;
export type PricingMode = (typeof PricingMode)[keyof typeof PricingMode];

export const KycStatus = {
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
} as const;
export type KycStatus = (typeof KycStatus)[keyof typeof KycStatus];

/**
 * Tipo de actor humano de la plataforma: PASSENGER (pasajero) · DRIVER (conductor). Es la FUENTE ÚNICA
 * de este dominio — reemplaza las uniones inline `'PASSENGER' | 'DRIVER'` y los `@IsIn(['PASSENGER',
 * 'DRIVER'])` crudos que estaban duplicados por los servicios (auth, chat, trip, rating…).
 *
 * Representación en MAYÚSCULAS porque es la PERSISTIDA (Prisma `enum UserType { PASSENGER DRIVER }`) y la
 * del contrato REST/DTOs. OJO: el claim `typ` del JWT usa minúsculas (`SubjectType = 'passenger' |
 * 'driver' | 'admin'` en `@veo/auth`) — es OTRA representación, del token, e incluye `admin`. NO se
 * mezclan: si alguna vez hay que cruzar capas, el mapeo es explícito en el borde, no por coincidencia.
 */
export const ActorType = {
  PASSENGER: 'PASSENGER',
  DRIVER: 'DRIVER',
} as const;
export type ActorType = (typeof ActorType)[keyof typeof ActorType];

/** Valores de `ActorType` para validadores de borde: `@IsIn(ACTOR_TYPES)`. Derivado del const, no re-tipeado. */
export const ACTOR_TYPES = Object.values(ActorType);

export const PanicStatus = {
  TRIGGERED: 'TRIGGERED',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  RESOLVED: 'RESOLVED',
  FALSE_ALARM: 'FALSE_ALARM',
} as const;
export type PanicStatus = (typeof PanicStatus)[keyof typeof PanicStatus];

export const AdminRole = {
  SUPPORT_L1: 'SUPPORT_L1',
  SUPPORT_L2: 'SUPPORT_L2',
  COMPLIANCE_SUPERVISOR: 'COMPLIANCE_SUPERVISOR',
  DISPATCHER: 'DISPATCHER',
  FINANCE: 'FINANCE',
  ADMIN: 'ADMIN',
  SUPERADMIN: 'SUPERADMIN',
} as const;
export type AdminRole = (typeof AdminRole)[keyof typeof AdminRole];

/**
 * Rango jerárquico de roles admin. Mayor número = más autoridad.
 * Regla: nadie otorga un rol de rango >= al suyo (excepción: SUPERADMIN sí otorga SUPERADMIN).
 * El `Record<AdminRole, number>` es EXHAUSTIVO: agregar un rol al enum sin rango rompe el typecheck (intencional).
 */
export const ADMIN_ROLE_RANK: Record<AdminRole, number> = {
  [AdminRole.SUPPORT_L1]: 10,
  [AdminRole.SUPPORT_L2]: 20,
  [AdminRole.DISPATCHER]: 30,
  [AdminRole.FINANCE]: 30,
  [AdminRole.COMPLIANCE_SUPERVISOR]: 40,
  [AdminRole.ADMIN]: 90,
  [AdminRole.SUPERADMIN]: 100,
};

/** Rango del rol más alto del actor (0 si no tiene roles con rango). */
export function maxRoleRank(roles: readonly AdminRole[]): number {
  return roles.reduce((m, r) => Math.max(m, ADMIN_ROLE_RANK[r] ?? 0), 0);
}

/**
 * ¿Puede `actorRoles` otorgar TODOS los `targetRoles`?
 * Regla ESTRICTA (`<`): solo roles de rango estrictamente menor al del actor.
 * Excepción: un SUPERADMIN sí puede otorgar SUPERADMIN (igual rango).
 */
export function canGrantRoles(
  actorRoles: readonly AdminRole[],
  targetRoles: readonly AdminRole[],
): boolean {
  const actorRank = maxRoleRank(actorRoles);
  const isSuperadmin = actorRank >= ADMIN_ROLE_RANK[AdminRole.SUPERADMIN];
  return targetRoles.every(
    (r) => ADMIN_ROLE_RANK[r] < actorRank || (isSuperadmin && r === AdminRole.SUPERADMIN),
  );
}

export const NotificationChannel = {
  PUSH: 'PUSH',
  SMS: 'SMS',
  EMAIL: 'EMAIL',
  WEBHOOK: 'WEBHOOK',
} as const;
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

export const NotificationStatus = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
} as const;
export type NotificationStatus = (typeof NotificationStatus)[keyof typeof NotificationStatus];

export const PayoutStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  PROCESSED: 'PROCESSED',
  HELD: 'HELD',
  FAILED: 'FAILED',
} as const;
export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];

export const DispatchOutcome = {
  OFFERED: 'OFFERED',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  TIMEOUT: 'TIMEOUT',
} as const;
export type DispatchOutcome = (typeof DispatchOutcome)[keyof typeof DispatchOutcome];

export const FleetDocumentType = {
  LICENSE_A1: 'LICENSE_A1',
  SOAT: 'SOAT',
  PROPERTY_CARD: 'PROPERTY_CARD',
  BACKGROUND_CHECK: 'BACKGROUND_CHECK',
  ITV: 'ITV',
} as const;
export type FleetDocumentType = (typeof FleetDocumentType)[keyof typeof FleetDocumentType];

export const FleetDocumentStatus = {
  PENDING_REVIEW: 'PENDING_REVIEW',
  VALID: 'VALID',
  EXPIRING_SOON: 'EXPIRING_SOON',
  EXPIRED: 'EXPIRED',
  REJECTED: 'REJECTED',
} as const;
export type FleetDocumentStatus = (typeof FleetDocumentStatus)[keyof typeof FleetDocumentStatus];
