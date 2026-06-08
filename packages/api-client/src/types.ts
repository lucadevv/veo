/**
 * Contrato compartido BFF ↔ web (vistas agregadas). Zod = fuente de verdad; los tipos se infieren.
 * Los BFFs DEBEN responder con estas formas; las apps web las consumen tipadas.
 * Montos siempre en céntimos PEN (enteros). Fechas ISO-8601 string.
 */
import { z } from 'zod';

export const geoPoint = z.object({ lat: z.number(), lon: z.number() });
export type GeoPoint = z.infer<typeof geoPoint>;

export const tripStatus = z.enum([
  // Ola 2B · viaje programado: estado previo a REQUESTED (aún no entra a dispatch).
  'SCHEDULED',
  'REQUESTED',
  'MATCHING',
  'ASSIGNED',
  'ACCEPTED',
  'ARRIVING',
  'ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  // PUJA/watchdog · estados que el contrato mobile DEBE poder expresar para no dejar al pasajero
  // colgado (antes el BFF los emitía y el cliente no los conocía). El dominio (trip-service,
  // @veo/shared-types) ya los maneja; acá los exponemos al cliente con la semántica mobile:
  //  - REASSIGNING: el conductor canceló pre-recojo, se re-abre la búsqueda/puja (transitorio).
  //  - EXPIRED: la puja cerró sin ofertas; el pasajero puede re-pujar más alto (NO terminal).
  //  - FAILED: el viaje en curso quedó abandonado y el watchdog lo cerró (terminal).
  'REASSIGNING',
  'EXPIRED',
  'FAILED',
]);
export type TripStatus = z.infer<typeof tripStatus>;

/* ── Sesión (admin-web) ── */
export const sessionUser = z.object({
  userId: z.string(),
  type: z.enum(['passenger', 'driver', 'admin']),
  roles: z.array(z.string()),
  mfaFresh: z.boolean(),
});
export type SessionUser = z.infer<typeof sessionUser>;

/* ── Vista pública de seguimiento familiar (family-web, /public/share/:token) ── */
export const familyDriver = z.object({
  name: z.string(),
  rating: z.number().nullable(),
  vehiclePlate: z.string().nullable(),
  vehicleModel: z.string().nullable(),
  vehicleColor: z.string().nullable(),
});
export type FamilyDriver = z.infer<typeof familyDriver>;

/**
 * Autorización de video del habitáculo (family-web). El bff es la ÚNICA fuente del token
 * (LiveKit self-hosted); si el viaje no autoriza la cámara, el bff responde 403/404 y la
 * web degrada a "sin video". Nunca se inventan credenciales en el cliente.
 */
export const familyVideoGrant = z.object({
  url: z.string().min(1),
  token: z.string().min(1),
  roomName: z.string().optional(),
});
export type FamilyVideoGrant = z.infer<typeof familyVideoGrant>;
export const familyTrackingView = z.object({
  tripId: z.string(),
  status: tripStatus,
  passengerName: z.string().nullable(),
  origin: geoPoint.nullable(),
  destination: geoPoint.nullable(),
  driverLocation: geoPoint.nullable(),
  etaSeconds: z.number().int().nullable(),
  driver: familyDriver.nullable(),
  routePolyline: z.string().nullable(),
  expiresAt: z.string(),
  revoked: z.boolean(),
});
export type FamilyTrackingView = z.infer<typeof familyTrackingView>;

/* ── Ops dashboard (admin-web) ── */
export const tripSummary = z.object({
  id: z.string(),
  status: tripStatus,
  passengerId: z.string(),
  driverId: z.string().nullable(),
  fareCents: z.number().int(),
  createdAt: z.string(),
});
export type TripSummary = z.infer<typeof tripSummary>;

export const panicSummary = z.object({
  id: z.string(),
  tripId: z.string(),
  passengerId: z.string(),
  status: z.string(),
  geo: geoPoint,
  triggeredAt: z.string(),
  acknowledgedAt: z.string().nullable(),
});
export type PanicSummary = z.infer<typeof panicSummary>;

export const driverSummary = z.object({
  id: z.string(),
  userId: z.string(),
  status: z.string(),
  averageRating: z.number().nullable(),
  backgroundCheckStatus: z.string(),
});
export type DriverSummary = z.infer<typeof driverSummary>;

export const fleetDocumentView = z.object({
  id: z.string(),
  ownerType: z.enum(['DRIVER', 'VEHICLE']),
  ownerId: z.string(),
  type: z.string(),
  status: z.string(),
  expiresAt: z.string().nullable(),
});
export type FleetDocumentView = z.infer<typeof fleetDocumentView>;

export const payoutView = z.object({
  id: z.string(),
  driverId: z.string(),
  amountCents: z.number().int(),
  status: z.string(),
  period: z.string(),
});
export type PayoutView = z.infer<typeof payoutView>;

export const auditEntryView = z.object({
  id: z.string(),
  seq: z.string(),
  actorId: z.string().nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  at: z.string(),
});
export type AuditEntryView = z.infer<typeof auditEntryView>;

export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
