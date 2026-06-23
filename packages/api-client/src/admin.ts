/**
 * Contrato compartido admin-bff ↔ admin-web.
 * Zod = fuente de verdad. Las formas reflejan EXACTAMENTE lo que devuelve admin-bff
 * (que a su vez proxea identity-service). admin-web consume estos schemas; no define los suyos.
 * Montos en céntimos PEN (enteros). Fechas ISO-8601 string.
 */
import { z } from 'zod';
import {
  geoPoint,
  tripStatus,
  tripSummary,
  driverSummary,
  fleetDocumentStatus,
  documentSide,
} from './types.js';
import { pricingMode } from './mobile.js';

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
  avgDurationSeconds: z.number().nullable(),
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
  // ISO-8601 de suspensión del conductor (identity DriverReply.suspendedAt); null si no está suspendido.
  driverSuspendedAt: z.string().nullable(),
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
  /** Motivo del último rechazo de antecedentes; `null` si no está rechazado o no se dio motivo. */
  rejectionReason: z.string().nullable(),
});
export type DriverApproval = z.infer<typeof driverApproval>;

/**
 * POST /ops/drivers/:id/reject → body. Motivo OPCIONAL del rechazo: lo escribe el operador y el conductor
 * lo VE en su app. admin-bff lo proxya a identity-service. Sin motivo ⇒ se omite (degradación honesta).
 */
export const rejectDriverRequest = z.object({
  reason: z.string().max(500).optional(),
});
export type RejectDriverRequest = z.infer<typeof rejectDriverRequest>;

/* ── Operadores del panel (staff): alta + asignación de roles RBAC (solo ADMIN/SUPERADMIN) ── */

/**
 * Roles RBAC asignables a un operador del panel admin. Espejo del enum `AdminRole` de @veo/shared-types
 * (fuente de verdad server-side). Se define acá como enum del CONTRATO para que admin-web tipe el selector
 * sin importar shared-types en el cliente. El admin-bff revalida `@Roles(...)` server-side (la UI no autoriza).
 */
export const adminRole = z.enum([
  'SUPPORT_L1',
  'SUPPORT_L2',
  'COMPLIANCE_SUPERVISOR',
  'DISPATCHER',
  'FINANCE',
  'ADMIN',
  'SUPERADMIN',
]);
export type AdminRoleValue = z.infer<typeof adminRole>;

/** Conductor pendiente de aprobación de antecedentes (GET /ops/drivers/pending → identity pending-approval). */
export const pendingDriver = z.object({
  id: z.string(),
  userId: z.string(),
  licenseNumber: z.string().nullable(),
  /** Nombre legal del onboarding (lo que el conductor cargó en la app); null si no lo cargó. */
  fullName: z.string().nullable(),
});
export type PendingDriver = z.infer<typeof pendingDriver>;

/* ── Sub-lote 3C · BINDING face-match DNI↔selfie ── */

/**
 * Estado del binding DNI↔selfie. Espeja `DniFaceMatchStatus` de @veo/shared-types (fuente de verdad
 * server-side). Se define acá como enum del CONTRATO para que admin-web lo tipe sin importar shared-types.
 *  - NOT_RUN: el match aún no se corrió.
 *  - MATCHED: la cara del DNI coincide con la biometría enrolada.
 *  - NO_MATCH: se corrió y NO coincide (revisar · posible suplantación).
 */
export const dniFaceMatchStatus = z.enum(['NOT_RUN', 'MATCHED', 'NO_MATCH']);
export type DniFaceMatchStatusValue = z.infer<typeof dniFaceMatchStatus>;

/**
 * Resultado de POST /ops/drivers/:id/dni-face-match: lo que devuelve el admin-bff (proxy de identity) al
 * disparar el match. `matched` = veredicto; `score` 0..100; `reason` = motivo legible si NO coincide (null
 * si coincide). El resultado además queda GUARDADO en identity (lo refleja `driverDetail.biometric`).
 */
export const dniFaceMatchResult = z.object({
  matched: z.boolean(),
  score: z.number(),
  reason: z.string().nullable(),
});
export type DniFaceMatchResult = z.infer<typeof dniFaceMatchResult>;

/* ── Revisión detallada de conductor (GET /ops/drivers/:id) ── */

/**
 * Tipo de documento de flota. Espeja `FleetDocumentType` de @veo/shared-types (fuente de verdad
 * server-side). Se define acá como enum del CONTRATO para que admin-web tipe la revisión de documentos
 * sin importar shared-types en el cliente. `fleetDocumentStatus` (el ESTADO) se reutiliza de ./types.
 */
export const fleetDocumentType = z.enum([
  'LICENSE_A1',
  'SOAT',
  'PROPERTY_CARD',
  'BACKGROUND_CHECK',
  'ITV',
  'AMBULANCE_OPERATOR',
  'TOW_OPERATOR',
  'MECHANIC_CERT',
  'VEHICLE_PHOTO',
  'DNI',
]);
export type FleetDocumentTypeValue = z.infer<typeof fleetDocumentType>;

/**
 * Una IMAGEN de un documento en la vista de revisión del operador (sub-lote 3A). `url` es una presigned
 * GET URL (acceso temporal al binario); `null` si la firma falló (fail-soft). `side` es la cara tipada.
 */
export const adminDocumentImage = z.object({
  side: documentSide,
  order: z.number().int(),
  url: z.string().nullable(),
});
export type AdminDocumentImage = z.infer<typeof adminDocumentImage>;

/**
 * Un documento del conductor en la vista de revisión del operador. `images` son las N caras (sub-lote
 * 3A · DNI anverso+reverso, N fotos de vehículo), cada una con su presigned GET URL. `url` es la URL de
 * la PRIMERA imagen (DEPRECADO · backward-compat para el render de 1 imagen); `null` si no hay archivo.
 * `rejectionReason` lo escribe el operador. Nombrado `adminDriverDocument` para no colisionar con el
 * `driverDocument` de ./mobile (vista del conductor en su app, otra forma: usa `simpleStatus`).
 */
export const adminDriverDocument = z.object({
  id: z.string(),
  type: fleetDocumentType,
  status: fleetDocumentStatus,
  expiresAt: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  /** DEPRECADO (sub-lote 3A): URL de la primera imagen. Usar `images`. null si no hay archivo aún. */
  url: z.string().nullable(),
  /** Las N imágenes del documento con su presigned GET URL (ordenadas). [] si no se subió ninguna. */
  images: z.array(adminDocumentImage),
});
export type AdminDriverDocument = z.infer<typeof adminDriverDocument>;

/**
 * Detalle de revisión de un conductor (GET /ops/drivers/:id): datos core + estado biométrico +
 * documentos. El operador lo usa para aprobar/rechazar antecedentes. Fechas ISO-8601 string.
 */
/**
 * Ficha del VEHÍCULO del conductor en el detalle de revisión (F2 · "admin valida informado"). El
 * operador ve QUÉ auto opera antes de aprobar. Sale de fleet (GetDriverVehicles); `null` si el conductor
 * aún no registró vehículo.
 */
export const driverVehicle = z.object({
  id: z.string(),
  plate: z.string(),
  make: z.string(),
  model: z.string(),
  year: z.number(),
  color: z.string(),
  vehicleType: z.string(),
  docStatus: z.string(),
  active: z.boolean(),
});
export type DriverVehicle = z.infer<typeof driverVehicle>;

export const driverDetail = z.object({
  id: z.string(),
  userId: z.string(),
  fullName: z.string().nullable(),
  phone: z.string().nullable(),
  licenseNumber: z.string().nullable(),
  // DNI + fecha de nacimiento (IDENTIDAD personal · Compliance+); null si no registrados.
  dni: z.string().nullable(),
  birthDate: z.string().nullable(),
  backgroundCheckStatus: z.string(),
  kycStatus: z.string(),
  currentStatus: z.string(),
  createdAt: z.string(),
  rejectionReason: z.string().nullable(),
  biometric: z.object({
    faceEnrolledAt: z.string().nullable(),
    lastVerifiedAt: z.string().nullable(),
    /**
     * Sub-lote 3C · BINDING DNI↔selfie. El operador VE este resultado antes de aprobar (no aprueba a
     * ciegas). `dniFaceMatchStatus` tipado (NOT_RUN/MATCHED/NO_MATCH); `dniFaceMatchScore` 0..100 (null si
     * no se corrió); `dniFaceMatchedAt` ISO-8601 (null si no se corrió). Lo corre identity, acá solo se VE.
     */
    dniFaceMatchStatus: dniFaceMatchStatus,
    dniFaceMatchScore: z.number().nullable(),
    dniFaceMatchedAt: z.string().nullable(),
  }),
  // Ficha del vehículo que opera (F2 · C1); null si aún no registró ninguno.
  vehicle: driverVehicle.nullable(),
  documents: z.array(adminDriverDocument),
});
export type DriverDetail = z.infer<typeof driverDetail>;

/** Operador pendiente de aprobación (lo que devuelve GET /ops/operators/pending). */
export const pendingOperator = z.object({
  id: z.string(),
  email: z.string(),
  createdAt: z.string(),
});
export type PendingOperator = z.infer<typeof pendingOperator>;

/** Resultado de aprobar un operador: queda activo con los roles asignados. */
export const operatorApproval = z.object({
  id: z.string(),
  status: z.string(),
  roles: z.array(adminRole),
});
export type OperatorApproval = z.infer<typeof operatorApproval>;

/**
 * Estado de un operador del panel (alta por invitación, B-onboarding):
 *  - INVITED: invitado, aún no aceptó (puede reinvitarse o cancelarse).
 *  - ACTIVE: aceptó la invitación y enroló su credencial (puede suspenderse/revocarse).
 *  - SUSPENDED: revocado/suspendido.
 *  - REJECTED: invitación cancelada/rechazada.
 * Tiparlo como enum (no `z.string()`) hace que comparar contra un literal fuera del set sea error de
 * compilación, no un magic string mudo. Fuente de verdad server-side: identity-service.
 */
export const operatorStatus = z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'REJECTED']);
export type OperatorStatus = z.infer<typeof operatorStatus>;

/** Un operador del panel tal como lo lista GET /ops/operators (gestión de staff · ADMIN/SUPERADMIN). */
export const operator = z.object({
  id: z.string(),
  email: z.string(),
  status: operatorStatus,
  roles: z.array(z.string()),
  createdAt: z.string(),
});
export type Operator = z.infer<typeof operator>;

/** Body del POST /ops/operators: alta por invitación (email + roles RBAC a otorgar). Step-up MFA. */
export const createOperatorRequest = z.object({
  email: z.string().email(),
  roles: z.array(adminRole).min(1),
});
export type CreateOperatorRequest = z.infer<typeof createOperatorRequest>;

/** Respuesta del POST /ops/operators: operador INVITED + link de invitación (también se envía por email). */
export const createOperatorResult = z.object({
  id: z.string(),
  inviteToken: z.string(),
  inviteUrl: z.string(),
  expiresAt: z.string(),
});
export type CreateOperatorResult = z.infer<typeof createOperatorResult>;

/** Respuesta del POST /ops/operators/:id/reinvite: nuevo link + vencimiento (re-emite la invitación). */
export const reinviteOperatorResult = z.object({
  inviteUrl: z.string(),
  expiresAt: z.string(),
});
export type ReinviteOperatorResult = z.infer<typeof reinviteOperatorResult>;

/** Body del POST /auth/invite/accept (PÚBLICO): token de invitación + contraseña elegida por el operador. */
export const acceptInviteRequest = z.object({
  token: z.string().min(1),
  password: z.string().min(10),
});
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequest>;

/** Respuesta del POST /auth/invite/accept: el email del operador recién activado. */
export const acceptInviteResult = z.object({ email: z.string() });
export type AcceptInviteResult = z.infer<typeof acceptInviteResult>;

/* ── Pricing: modo de despacho PUJA↔FIJO (schedule global · ADR 011) ── */
/* `pricingMode` ('PUJA'|'FIXED') se reutiliza de ./mobile (fuente única del enum), no se redefine. */

/** Una regla horaria del schedule: día (bitmask Lun=1..Dom=64) + rango en minutos del día (Lima) → modo. */
export const pricingModeRule = z.object({
  dayMask: z.number().int().min(1).max(127),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(0).max(1439),
  mode: pricingMode,
});
export type PricingModeRule = z.infer<typeof pricingModeRule>;

/** Schedule vigente (GET /pricing/mode-schedule): default + reglas + versión. */
export const modeScheduleView = z.object({
  version: z.number().int(),
  defaultMode: pricingMode,
  rules: z.array(pricingModeRule),
  updatedAt: z.string().nullable(),
});
export type ModeScheduleView = z.infer<typeof modeScheduleView>;

/** Body del PUT /pricing/mode-schedule: REEMPLAZA wholesale (default + reglas). `expectedVersion` = CAS. */
export const replaceScheduleRequest = z.object({
  defaultMode: pricingMode,
  rules: z.array(pricingModeRule),
  expectedVersion: z.number().int().nonnegative(),
});
export type ReplaceScheduleRequest = z.infer<typeof replaceScheduleRequest>;

/**
 * Config de combustible vigente (GET /pricing/fuel-surcharge · B4): el admin ingresa precio/litro +
 * rendimiento; `perKmCents` es el recargo/km DERIVADO (precio ÷ rendimiento) que el sistema aplica.
 */
export const fuelSurchargeView = z.object({
  fuelPricePerLiterCents: z.number().int().nonnegative(),
  kmPerLiter: z.number().int().nonnegative(),
  perKmCents: z.number().int().nonnegative(),
  version: z.number().int(),
  updatedAt: z.string(),
});
export type FuelSurchargeView = z.infer<typeof fuelSurchargeView>;

/**
 * Body del PUT /pricing/fuel-surcharge (B4): precio del combustible/litro + rendimiento km/litro.
 * `expectedVersion` = optimistic locking (CAS): la versión que el panel cargó; el server reemplaza solo si
 * sigue vigente, si otro admin la movió responde 409 (el panel recarga y reintenta). 0 = primer write.
 */
export const replaceFuelSurchargeRequest = z.object({
  fuelPricePerLiterCents: z.number().int().nonnegative(),
  kmPerLiter: z.number().int().nonnegative(),
  expectedVersion: z.number().int().nonnegative(),
});

/**
 * Catálogo de precios de energía por fuente (B5). El admin edita el precio por unidad (céntimos/litro o
 * /kWh según la fuente); la `unit` la deriva el server. `expectedVersion` = optimistic locking (CAS).
 */
export const energySourcePrice = z.object({
  sourceId: z.string(),
  unit: z.string(),
  pricePerUnitCents: z.number().int().nonnegative(),
});
export type EnergySourcePrice = z.infer<typeof energySourcePrice>;

export const energyCatalogView = z.object({
  sources: z.array(energySourcePrice),
  version: z.number().int(),
  updatedAt: z.string(),
});
export type EnergyCatalogView = z.infer<typeof energyCatalogView>;

export const replaceEnergyCatalogRequest = z.object({
  sources: z.array(
    z.object({ sourceId: z.string(), pricePerUnitCents: z.number().int().nonnegative() }),
  ),
  expectedVersion: z.number().int().nonnegative(),
});
export type ReplaceEnergyCatalogRequest = z.infer<typeof replaceEnergyCatalogRequest>;
export type ReplaceFuelSurchargeRequest = z.infer<typeof replaceFuelSurchargeRequest>;

/* ── Piso de la PUJA (bid floor) per-(zona, oferta) · ADR 010 §9.3 ── */

/** Un override del piso para una (zona, oferta). `zone`/`offeringId` viajan como string (enums del dominio). */
export const bidFloorOverride = z.object({
  zone: z.string(),
  offeringId: z.string(),
  floorCents: z.number().int().nonnegative(),
});
export type BidFloorOverride = z.infer<typeof bidFloorOverride>;

/** Piso vigente (GET /pricing/bid-floor): piso por defecto + overrides por (zona, oferta) + versión. */
export const bidFloorView = z.object({
  defaultFloorCents: z.number().int().nonnegative(),
  overrides: z.array(bidFloorOverride),
  version: z.number().int(),
  updatedAt: z.string(),
});
export type BidFloorView = z.infer<typeof bidFloorView>;

/**
 * Body del PUT /pricing/bid-floor (ADR 010 §9.3): piso por defecto + overrides por (zona, oferta).
 * `expectedVersion` = optimistic locking (CAS); si otro admin la movió → 409 (el panel recarga). 0 = primer write.
 */
export const replaceBidFloorRequest = z.object({
  defaultFloorCents: z.number().int().positive(),
  overrides: z.array(bidFloorOverride),
  expectedVersion: z.number().int().nonnegative(),
});
export type ReplaceBidFloorRequest = z.infer<typeof replaceBidFloorRequest>;

// ── Catálogo de ofertas (ADR 013 · Fase B/B1) ──────────────────────────────────────────────────────

// `pricingMode` ('PUJA'|'FIXED') se reutiliza de ./mobile (fuente única del enum), ya importado arriba.

/** Política de pricing EFECTIVA de una oferta (base de código ⟕ override del admin). */
export const offeringPricing = z.object({
  multiplier: z.number().positive(),
  minFareCents: z.number().int().nonnegative(),
});
export type OfferingPricing = z.infer<typeof offeringPricing>;

/**
 * Una oferta del catálogo efectivo (GET /catalog): tokens de display + estado configurable. B2 suma
 * `allowedModes` (el panel restringe el select del modo a esto — la UI refleja el invariante de producto),
 * `pricing` EFECTIVO (lo que se cobra hoy) y `modePin` (modo pineado por el admin, o ausente = manda el schedule).
 */
export const catalogOffering = z.object({
  id: z.string(),
  labelKey: z.string(),
  icon: z.string(),
  vehicleClass: z.enum(['CAR', 'MOTO']),
  sortOrder: z.number().int(),
  enabled: z.boolean(),
  allowedModes: z.array(pricingMode),
  pricing: offeringPricing,
  modePin: pricingMode.optional(),
});
export type CatalogOffering = z.infer<typeof catalogOffering>;

/**
 * Override CRUDO de una oferta (lo que el admin tiene seteado explícitamente). B1: enabled. B2: mode
 * (pin), multiplier, minFareCents (opcionales; ausentes → el valor de código). Es el shape que viaja en
 * AMBOS sentidos: GET /catalog lo devuelve (overlay actual) y PUT /catalog lo reemplaza wholesale.
 */
export const catalogOverride = z.object({
  id: z.string(),
  enabled: z.boolean(),
  mode: pricingMode.optional(),
  multiplier: z.number().positive().optional(),
  minFareCents: z.number().int().nonnegative().optional(),
});
export type CatalogOverride = z.infer<typeof catalogOverride>;

/** Catálogo efectivo (GET /catalog): ofertas EFECTIVAS (display) + overlay CRUDO (edición) + versión. */
export const catalogView = z.object({
  version: z.number().int(),
  updatedAt: z.string(),
  offerings: z.array(catalogOffering),
  overrides: z.array(catalogOverride),
});
export type CatalogView = z.infer<typeof catalogView>;

/** Body del PUT /catalog: REEMPLAZA wholesale el overlay. trip-service RE-VALIDA + ignora pins inválidos. `expectedVersion` = CAS. */
export const replaceCatalogRequest = z.object({
  overrides: z.array(catalogOverride),
  expectedVersion: z.number().int().nonnegative(),
});
export type ReplaceCatalogRequest = z.infer<typeof replaceCatalogRequest>;

/* ── Dispatch: config de RADIOS (k-rings) singleton global ── */

/** Config de radios vigente (GET /admin/dispatch/radius-config): k-rings + versión + sello. */
export const dispatchRadiusConfigView = z.object({
  nearbyKRing: z.number().int().min(1).max(8),
  matchKRing: z.number().int().min(1).max(8),
  version: z.number().int(),
  updatedAt: z.string(),
});
export type DispatchRadiusConfigView = z.infer<typeof dispatchRadiusConfigView>;

/** Body del PUT /admin/dispatch/radius-config: REEMPLAZA los k-rings (bump version aguas abajo). */
export const replaceRadiusConfigRequest = z.object({
  nearbyKRing: z.number().int().min(1).max(8),
  matchKRing: z.number().int().min(1).max(8),
});
export type ReplaceRadiusConfigRequest = z.infer<typeof replaceRadiusConfigRequest>;

/* ── Finanzas: resultado del batch de liquidaciones (POST /finance/payouts/run) ── */
export const runPayoutsResult = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  processed: z.number().int(),
  held: z.number().int(),
  totalAmountCents: z.number().int(),
});
export type RunPayoutsResult = z.infer<typeof runPayoutsResult>;

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

/* ── Catálogo de modelos: cola de revisión del operador (B5-2.c) ── */
/** Estado de revisión de un modelo (espeja VehicleModelStatus de fleet-service). Tipado → sin magic strings. */
export const vehicleModelStatus = z.enum(['PENDING_REVIEW', 'APPROVED', 'REJECTED']);
export type VehicleModelStatus = z.infer<typeof vehicleModelStatus>;

/**
 * Un modelo en la cola de revisión. Los campos técnicos (segment/energySource/efficiency) vienen NULL
 * mientras la solicitud está PENDING_REVIEW (el operador los completa al aprobar). `requestedBy` = quién
 * lo solicitó (User.id del conductor, o null si lo curó el operador); `verifiedBy` = quién lo resolvió.
 */
export const vehicleModelReviewView = z.object({
  id: z.string(),
  make: z.string(),
  model: z.string(),
  yearFrom: z.number().int(),
  yearTo: z.number().int(),
  vehicleType: z.string(),
  seats: z.number().int(),
  segment: z.string().nullable(),
  energySource: z.string().nullable(),
  efficiency: z.number().int().nullable(),
  status: vehicleModelStatus,
  requestedBy: z.string().nullable(),
  verifiedBy: z.string().nullable(),
  createdAt: z.string(),
});
export type VehicleModelReviewView = z.infer<typeof vehicleModelReviewView>;

/**
 * Aprobación de una solicitud de modelo: el operador completa la ficha técnica (y corrige asientos si hace
 * falta). El fleet-service valida segment/energySource contra los enums de dominio y mueve PENDING→APPROVED.
 */
export const approveVehicleModelRequest = z.object({
  segment: z.enum(['ECONOMY', 'MID', 'PREMIUM']),
  energySource: z.enum(['GASOLINE_95', 'GASOLINE_84', 'DIESEL', 'GNV', 'ELECTRIC']),
  efficiency: z.number().int().min(1).max(1000),
  seats: z.number().int().min(1).max(20).optional(),
});
export type ApproveVehicleModelRequest = z.infer<typeof approveVehicleModelRequest>;

/* ── Flota: requests de alta (admin) ── */
/**
 * Alta de vehículo por el operador (F4 · C2). El operador ELIGE un modelo del catálogo curado
 * (`modelSpecId`, VehicleModelSpec APPROVED): make/model/vehicleType se snapshotean del spec server-side
 * — la MISMA fuente única que usa el conductor en el onboarding, sin texto libre divergente. `make`/`model`
 * libres siguen aceptados (scripts/seeds legacy): el `.refine` exige UNO de los dos caminos. `year` acotado;
 * el fleet-service revalida BR-D04 (año mínimo + placa única + clase operable).
 */
export const createVehicleRequest = z
  .object({
    plate: z.string().min(1),
    /** Id del modelo del catálogo APROBADO. Si viene, make/model/vehicleType salen del spec (server-authoritative). */
    modelSpecId: z.string().uuid().optional(),
    /** Marca a texto libre. Requerida solo si NO se eligió un modelo del catálogo. */
    make: z.string().min(1).optional(),
    /** Modelo a texto libre. Requerido solo si NO se eligió un modelo del catálogo. */
    model: z.string().min(1).optional(),
    year: z.number().int().min(1950).max(2100),
    color: z.string().min(1),
    fleetId: z.string().optional(),
    insuranceExpiresAt: z.string().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.modelSpecId) || (Boolean(v.make) && Boolean(v.model)), {
    message: 'Elegí un modelo del catálogo o indicá marca y modelo',
    path: ['modelSpecId'],
  });
export type CreateVehicleRequest = z.infer<typeof createVehicleRequest>;

/**
 * Un modelo del catálogo APROBADO (GET /fleet/vehicle-models · F4). Es lo que consume el SELECTOR del alta
 * admin: solo los campos que necesita para elegir (id + identificación + rango de años + tipo + asientos).
 * Espeja `VehicleModelSpecView` de fleet-service; los campos técnicos extra (segment/energía/eficiencia) se
 * omiten acá (el selector no los muestra; zod descarta lo que sobra).
 */
export const vehicleModelSpecView = z.object({
  id: z.string(),
  make: z.string(),
  model: z.string(),
  yearFrom: z.number().int(),
  yearTo: z.number().int(),
  vehicleType: z.string(),
  seats: z.number().int(),
});
export type VehicleModelSpecView = z.infer<typeof vehicleModelSpecView>;

/** Una imagen del documento en el alta (sub-lote 3A): clave S3 ya subida + cara tipada. */
export const createDocumentImage = z.object({
  s3Key: z.string().min(1),
  side: documentSide,
});
export type CreateDocumentImage = z.infer<typeof createDocumentImage>;

/**
 * Alta de documento (conductor/vehículo). Entra PENDING_REVIEW hasta que el operador lo valide.
 * Sub-lote 3A: `images` (1..N caras) es el camino nuevo; `fileS3Key` queda DEPRECADO (backward-compat).
 */
export const createDocumentRequest = z.object({
  ownerType: z.enum(['DRIVER', 'VEHICLE']),
  ownerId: z.string().min(1),
  type: z.string().min(1),
  documentNumber: z.string().min(1),
  issuedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  /** DEPRECADO (sub-lote 3A): clave singular. Usar `images`. */
  fileS3Key: z.string().optional(),
  /** Imágenes del documento (1..N caras). DNI → [FRONT, BACK]; foto de vehículo → N SINGLE. */
  images: z.array(createDocumentImage).min(1).optional(),
});
export type CreateDocumentRequest = z.infer<typeof createDocumentRequest>;

/**
 * Registro de una inspección técnica (ITV) ya realizada. El fleet-service calcula el próximo vencimiento.
 * SIN `inspectorId`: la identidad del inspector NO es client-supplied — la fija fleet-service desde el JWT
 * del operador (server-truth · integridad del audit de compliance). Mandarla por el body no tendría efecto.
 */
export const createInspectionRequest = z.object({
  vehicleId: z.string().min(1),
  passed: z.boolean(),
  inspectedAt: z.string().optional(),
  notes: z.string().optional(),
});
export type CreateInspectionRequest = z.infer<typeof createInspectionRequest>;

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

/* ── Media EN VIVO: muro de cámaras (token solo-suscripción · doble-auth rol+MFA · auditado) ── */
/** Body del POST /media/live/token: viaje + motivo (> 20 chars). La identidad del operador la deriva el bff. */
export const liveAccessRequest = z.object({
  tripId: z.string(),
  reason: z.string().min(21, 'El motivo debe tener más de 20 caracteres'),
});
export type LiveAccessRequest = z.infer<typeof liveAccessRequest>;

/** Credenciales LiveKit solo-suscripción para mirar la cabina en vivo de un viaje en curso. */
export const liveViewerToken = z.object({
  roomName: z.string(),
  token: z.string(),
  url: z.string(),
  expiresInSeconds: z.number().int(),
});
export type LiveViewerToken = z.infer<typeof liveViewerToken>;

/* ── Auditoría: verificación de cadena hash ── */
export const auditChainVerification = z.object({
  valid: z.boolean(),
  checkedEntries: z.number().int(),
  brokenAtSeq: z.string().nullable(),
  verifiedAt: z.string(),
});
export type AuditChainVerification = z.infer<typeof auditChainVerification>;
