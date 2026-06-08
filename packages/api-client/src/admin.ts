/**
 * Contrato compartido admin-bff ↔ admin-web.
 * Zod = fuente de verdad. Las formas reflejan EXACTAMENTE lo que devuelve admin-bff
 * (que a su vez proxea identity-service). admin-web consume estos schemas; no define los suyos.
 * Montos en céntimos PEN (enteros). Fechas ISO-8601 string.
 */
import { z } from 'zod';
import { geoPoint, tripStatus, tripSummary, driverSummary } from './types.js';

/* ── Autenticación admin (login + enrolamiento/step-up TOTP) ── */

/** Tokens admin emitidos por identity y devueltos al caller (admin-web los persiste en cookie httpOnly). */
export const adminTokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  admin: z.object({
    id: z.string(),
    email: z.string(),
    roles: z.array(z.string()),
  }),
});
export type AdminTokens = z.infer<typeof adminTokens>;

/** Challenge de primer enrolamiento TOTP: el operador aún no tiene MFA y debe escanear el QR. */
export const totpEnrollChallenge = z.object({
  mustEnrollTotp: z.literal(true),
  otpauthUrl: z.string(),
});
export type TotpEnrollChallenge = z.infer<typeof totpEnrollChallenge>;

/** Resultado de POST /auth/login: tokens (login resuelto) o challenge de enrolamiento. */
export const adminLoginResult = z.union([adminTokens, totpEnrollChallenge]);
export type AdminLoginResult = z.infer<typeof adminLoginResult>;

/** Discrimina el resultado de login sin perder el tipado. */
export function isTotpEnrollChallenge(r: AdminLoginResult): r is TotpEnrollChallenge {
  return 'mustEnrollTotp' in r && r.mustEnrollTotp === true;
}

/** Rotación de refresh: nuevo par de tokens. */
export const adminRefreshResult = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type AdminRefreshResult = z.infer<typeof adminRefreshResult>;

/** Step-up MFA: re-emite un access con mfaAt fresco (para acciones sensibles). */
export const stepUpResult = z.object({ accessToken: z.string() });
export type StepUpResult = z.infer<typeof stepUpResult>;

/**
 * Ticket efímero de un solo uso para el handshake de Socket.IO `/ops`.
 * admin-web (route handler server-side) lo acuña con su Bearer y lo entrega al navegador,
 * que nunca ve el JWT. El gateway /ops lo verifica y consume contra Redis.
 */
export const wsTicket = z.object({
  ticket: z.string(),
  expiresAt: z.string(),
});
export type WsTicket = z.infer<typeof wsTicket>;

/* ── Analytics overview (/analytics/overview) ── */
export const overviewSeriesPoint = z.object({
  bucket: z.string(),
  trips: z.number().int(),
  revenueCents: z.number().int(),
});
export type OverviewSeriesPoint = z.infer<typeof overviewSeriesPoint>;

export const analyticsOverview = z.object({
  activeTrips: z.number().int(),
  onlineDrivers: z.number().int(),
  openPanics: z.number().int(),
  completedToday: z.number().int(),
  cancelledToday: z.number().int(),
  revenueTodayCents: z.number().int(),
  avgEtaSeconds: z.number().nullable(),
  series: z.array(overviewSeriesPoint),
});
export type AnalyticsOverview = z.infer<typeof analyticsOverview>;

/* ── Detalle de viaje (/trips/:id) ── */
export const tripDetail = tripSummary.extend({
  origin: geoPoint.nullable(),
  destination: geoPoint.nullable(),
  driverLocation: geoPoint.nullable(),
  routePolyline: z.string().nullable(),
  etaSeconds: z.number().int().nullable(),
  distanceMeters: z.number().nullable(),
  passengerName: z.string().nullable(),
  driverName: z.string().nullable(),
  vehiclePlate: z.string().nullable(),
  paymentMethod: z.string().nullable(),
  timeline: z.array(z.object({ status: tripStatus, at: z.string() })),
});
export type TripDetail = z.infer<typeof tripDetail>;

/* ── Pánico detallado (/panics/:id) ── */
export const panicDetail = z.object({
  id: z.string(),
  tripId: z.string(),
  passengerId: z.string(),
  passengerName: z.string().nullable(),
  driverId: z.string().nullable(),
  driverName: z.string().nullable(),
  status: z.string(),
  geo: geoPoint,
  triggeredAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  acknowledgedBy: z.string().nullable(),
  notes: z.string().nullable(),
  evidence: z.array(
    z.object({ id: z.string(), kind: z.string(), label: z.string(), at: z.string() }),
  ),
});
export type PanicDetail = z.infer<typeof panicDetail>;

/* ── Conductor con datos de aprobación (/drivers) ── */
export const driverApproval = driverSummary.extend({
  fullName: z.string().nullable(),
  phone: z.string().nullable(),
  submittedAt: z.string().nullable(),
});
export type DriverApproval = z.infer<typeof driverApproval>;

/* ── Flota: vehículos, inspecciones, vencimientos ── */
export const vehicleView = z.object({
  id: z.string(),
  plate: z.string(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  year: z.number().int().nullable(),
  color: z.string().nullable(),
  status: z.string(),
  driverId: z.string().nullable(),
});
export type VehicleView = z.infer<typeof vehicleView>;

export const inspectionView = z.object({
  id: z.string(),
  vehicleId: z.string(),
  status: z.string(),
  inspectedAt: z.string().nullable(),
  scheduledAt: z.string().nullable(),
  inspector: z.string().nullable(),
  result: z.string().nullable(),
});
export type InspectionView = z.infer<typeof inspectionView>;

export const expiringDocumentView = z.object({
  id: z.string(),
  ownerType: z.enum(['DRIVER', 'VEHICLE']),
  ownerId: z.string(),
  type: z.string(),
  status: z.string(),
  expiresAt: z.string(),
  daysUntilExpiry: z.number().int(),
});
export type ExpiringDocumentView = z.infer<typeof expiringDocumentView>;

/* ── Media: solicitud de acceso a video + URL firmada ── */
export const mediaAccessRequestView = z.object({
  id: z.string(),
  tripId: z.string(),
  requestedBy: z.string(),
  reason: z.string(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
});
export type MediaAccessRequestView = z.infer<typeof mediaAccessRequestView>;

export const signedMedia = z.object({
  url: z.string(),
  expiresAt: z.string(),
  watermark: z.string(),
});
export type SignedMedia = z.infer<typeof signedMedia>;

/* ── Auditoría: verificación de cadena hash ── */
export const auditChainVerification = z.object({
  valid: z.boolean(),
  checkedEntries: z.number().int(),
  brokenAtSeq: z.string().nullable(),
  verifiedAt: z.string(),
});
export type AuditChainVerification = z.infer<typeof auditChainVerification>;
