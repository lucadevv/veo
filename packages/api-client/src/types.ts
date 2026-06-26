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

/**
 * Alias DOMINIO (trip-service / @veo/shared-types) → contrato MOBILE. El dominio distingue QUIÉN
 * canceló (`CANCELLED_BY_PASSENGER`/`CANCELLED_BY_DRIVER`); el contrato mobile colapsa ambos en
 * `CANCELLED`. Fuente ÚNICA de verdad: los BFFs que reciben el status crudo del gRPC/REST de
 * trip-service DEBEN normalizarlo con `normalizeTripStatus` antes de exponerlo a las apps — si no, el
 * `safeParse` del cliente falla y el viaje cae a estado desconocido (bug histórico en driver-bff).
 */
export const DOMAIN_STATUS_ALIASES: Readonly<Record<string, TripStatus>> = {
  CANCELLED_BY_PASSENGER: 'CANCELLED',
  CANCELLED_BY_DRIVER: 'CANCELLED',
};

/**
 * Normaliza un status crudo del dominio al enum del contrato mobile. Devuelve `null` si el valor no
 * pertenece al contrato (el caller decide la política de error: los BFFs lanzan su 5xx de servicio).
 * NO lanza: api-client es contrato puro (solo depende de zod), sin acoplarse a un tipo de error HTTP.
 */
export function normalizeTripStatus(raw: string): TripStatus | null {
  const canonical = DOMAIN_STATUS_ALIASES[raw] ?? raw;
  const parsed = tripStatus.safeParse(canonical);
  return parsed.success ? parsed.data : null;
}

/**
 * ¿El pasajero está A BORDO? (= viaje en curso, `IN_PROGRESS`). Predicado de FASE tipado: el caller
 * pasa un `TripStatus` del contrato (no un string suelto), así comparar contra un valor fuera del enum
 * es error de compilación, no un magic string mudo. Lo consume el driver-bff para decidir el ORIGEN de
 * la navegación: onboard ⇒ ruta directa al destino; pre-recojo ⇒ pasar por el recojo primero.
 */
export function isOnboard(status: TripStatus): boolean {
  return status === 'IN_PROGRESS';
}

/**
 * ¿La cámara EN VIVO del habitáculo está disponible? Política de DOMINIO única (BR-S01): solo
 * durante el viaje en curso. La comparten los TRES gates (public-bff `videoGrant`, driver-bff
 * `issuePublisherToken`, admin-bff `issueLiveToken`): si mañana la política cambia (p.ej. incluir
 * ARRIVED), se cambia ACÁ y los tres BFFs la heredan — no se caza copy-paste. El caller normaliza
 * el status crudo del gRPC con `normalizeTripStatus` antes de preguntar (raw fuera del contrato ⇒
 * `null` ⇒ se niega el acceso: fail-closed).
 */
export function canAccessLiveCabin(status: TripStatus): boolean {
  return status === 'IN_PROGRESS';
}

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
/**
 * Estado de viaje en la vista OPS: el contrato mobile + `UNKNOWN`. `UNKNOWN` es el camino HONESTO
 * para un status crudo que no pertenece al contrato (drift de versión, dato corrupto): ops ve
 * "Desconocido" y escala, en vez de un `REQUESTED` falso que esconde el problema (bug histórico:
 * REASSIGNING — pasajero abandonado, ops DEBE intervenir — se mostraba como REQUESTED).
 */
export const adminTripStatus = z.enum([...tripStatus.options, 'UNKNOWN']);
export type AdminTripStatus = z.infer<typeof adminTripStatus>;

export const tripSummary = z.object({
  id: z.string(),
  status: adminTripStatus,
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

/**
 * Estado de un documento de flota. Espeja `FleetDocumentStatus` de fleet-service (enum Prisma) y
 * @veo/shared-types. Tiparlo (no `z.string()`) hace que comparar contra un literal fuera del set sea
 * error de compilación, no un magic string mudo (ej. el tab muerto `PENDING` vs `PENDING_REVIEW`).
 */
export const fleetDocumentStatus = z.enum([
  'PENDING_REVIEW',
  'VALID',
  'EXPIRING_SOON',
  'EXPIRED',
  'REJECTED',
]);

/**
 * Sub-lote 3A · cara/lado de una IMAGEN de documento (múltiples imágenes por documento). Espeja el enum
 * `DocumentSide` de fleet-service (Prisma) y @veo/shared-types. SINGLE = una sola cara/foto; FRONT/BACK =
 * anverso/reverso (DNI). Definido acá (base compartida) para que admin.ts y mobile.ts lo reusen sin colisión.
 */
export const documentSide = z.enum(['FRONT', 'BACK', 'SINGLE']);
export type DocumentSideValue = z.infer<typeof documentSide>;

export const fleetDocumentView = z.object({
  id: z.string(),
  ownerType: z.enum(['DRIVER', 'VEHICLE']),
  ownerId: z.string(),
  type: z.string(),
  status: fleetDocumentStatus,
  expiresAt: z.string().nullable(),
});
export type FleetDocumentView = z.infer<typeof fleetDocumentView>;

/**
 * Estado de una liquidación (payout). Espeja `PayoutStatus` de payment-service (enum Prisma) y
 * @veo/shared-types. Tiparlo como enum (no `z.string()`) hace que cualquier comparación contra un
 * literal fuera de este set sea error de compilación, no un bug mudo (ej. la UI esperaba `'PAID'`,
 * el back emite `'PROCESSED'`). Fuente de verdad: services/payment-service/prisma/schema.prisma.
 */
export const payoutStatus = z.enum(['PENDING', 'PROCESSING', 'PROCESSED', 'HELD', 'FAILED']);
export type PayoutStatus = z.infer<typeof payoutStatus>;

/**
 * Desglose de la liquidación (ADR-015 D6). El conductor ya ve gross/commission/neto en su app; el panel
 * FINANCE debe tener PARIDAD para auditar. Dinero SIEMPRE Int céntimos (formatear a S/ SOLO en la UI).
 *  - `grossCents`: ticket bruto del período (base de la comisión).
 *  - `commissionCents`: retención de la plataforma (commission(gross, rate)).
 *  - `amountCents`: NETO desembolsado al conductor (= gross − commission + propinas/bonos netos).
 *  - `processedAt`: instante en que el riel confirmó la salida (PROCESSED); null mientras no se procesó.
 *  - `heldReason`: motivo de retención (solo poblado en HELD); null en el resto de estados.
 * Ampliación ADDITIVE sobre el contrato previo (amountCents queda = NETO): no rompe consumidores.
 */
export const payoutView = z.object({
  id: z.string(),
  driverId: z.string(),
  grossCents: z.number().int(),
  commissionCents: z.number().int(),
  amountCents: z.number().int(),
  status: payoutStatus,
  period: z.string(),
  processedAt: z.string().nullable(),
  heldReason: z.string().nullable(),
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
