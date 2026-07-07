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
  vehicleOperabilityReason,
  documentSide,
} from './types.js';
import { pricingMode, paymentStatus, mobilePaymentMethod } from './mobile.js';

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
  /**
   * CAUSAS de suspensión (DISCIPLINARY/DOCUMENT_EXPIRED/INSPECTION_EXPIRED · modelo de HOLDS) del conductor,
   * para que la LISTA del panel ofrezca la acción de reactivación correcta por fila (cause-aware), igual que
   * el detalle (`driverDetail.suspensionCauses`). `[]` si no está suspendido.
   */
  suspensionCauses: z.array(z.string()),
  /** Completitud documental: cuántos docs REQUERIDOS están en VALID sobre el total (columna "Documentos X/Y").
   *  No es PII (solo enteros) → visible para todos los roles que ven la lista. */
  docsComplete: z.number().int(),
  docsTotal: z.number().int(),
  /** Estado combinado de verificación biométrica para la columna "Verificación": VERIFICADO (ambos face-match
   *  coinciden) · REVISAR (algún NO_MATCH) · PENDIENTE (aún no corrió). `null` para roles sub-Compliance
   *  (redactado como el nombre/teléfono — es señal del proceso KYC, ADMIN/Compliance+). */
  verificationStatus: z.string().nullable(),
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
  /** Completitud documental (docs REQUERIDOS en VALID / total) para el embudo Sin docs / Listos. */
  docsComplete: z.number().int(),
  docsTotal: z.number().int(),
  /** Verificación biométrica combinada (VERIFICADO/REVISAR/PENDIENTE); null para roles sub-Compliance. */
  verificationStatus: z.string().nullable(),
  /** ISO-8601 de encolado (alta del conductor) para el SLA/orden de la cola de Revisiones; null si sin dato. */
  enqueuedAt: z.string().nullable(),
});
export type PendingDriver = z.infer<typeof pendingDriver>;

/** Conteo del EMBUDO de onboarding de conductores (stat cards del panel · frame AdminConductores). El tramo
 *  PENDING se parte por completitud documental: `sinDocs` (faltan requeridos) vs `listos` (todos en VALID,
 *  listos para que el operador revise). `cleared`/`rejected` son las decisiones finales de antecedentes. */
export const driverCounts = z.object({
  sinDocs: z.number().int(),
  listos: z.number().int(),
  /** PENDING con docs completos y face-match ya corrido (revisión en curso). */
  enRevision: z.number().int(),
  cleared: z.number().int(),
  rejected: z.number().int(),
});
export type DriverCounts = z.infer<typeof driverCounts>;

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
 * Estado del LIVENESS PASIVO (anti-spoofing PAD del enrol) que el operador VE antes de aprobar:
 *  - NOT_RUN: el conductor aún no enroló biometría (o enroló antes de que existiera el campo).
 *  - PASSED: el PAD corrió sobre la selfie y la dio por viva (no es impresa/pantalla).
 *  - DEGRADED: enroló PERO el PAD no corrió (modelo ausente → sin anti-spoofing). Un spoof NUNCA llega acá
 *    (se rechaza en el enrol). `approve()` exige PASSED (el PAD se ejecutó) — server-side, curl-proof.
 */
export const passiveLivenessStatus = z.enum(['NOT_RUN', 'PASSED', 'DEGRADED']);
export type PassiveLivenessStatusValue = z.infer<typeof passiveLivenessStatus>;

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
    /**
     * Lote C · BINDING licencia↔selfie (gemelo del DNI · binding MÁS FUERTE). Reusa el mismo enum de estado
     * (NOT_RUN/MATCHED/NO_MATCH). El operador VE ambos bindings antes de aprobar; approve() exige los dos
     * ejecutados. `licenseFaceMatchScore` 0..100 (null si no se corrió · el brevete es low-res → suele ser más
     * bajo); `licenseFaceMatchedAt` ISO-8601 (null si no se corrió).
     */
    licenseFaceMatchStatus: dniFaceMatchStatus,
    licenseFaceMatchScore: z.number().nullable(),
    licenseFaceMatchedAt: z.string().nullable(),
    /**
     * F5 · presigned GET URL de la SELFIE del enrol (ayuda visual del operador en casos dudosos). `null` si no
     * hay selfie guardada (best-effort) o si la firma falló. El operador la VE junto al score del match; NO es
     * la verificación (esa la hace el match contra DNI/licencia) — es evidencia visual para dirimir un NO_MATCH.
     */
    faceSelfieUrl: z.string().nullable(),
    /**
     * LIVENESS PASIVO (anti-spoofing PAD del enrol). El operador VE si la selfie pasó el anti-spoofing antes de
     * aprobar. `livenessStatus` tipado (NOT_RUN/PASSED/DEGRADED); `livenessScore` 0..1 de la clase viva (null si
     * no se corrió). Un spoof NO llega acá (se rechaza en el enrol, 422). `approve()` exige PASSED server-side.
     */
    livenessStatus: passiveLivenessStatus,
    livenessScore: z.number().nullable(),
  }),
  // Ficha del vehículo que opera (F2 · C1); null si aún no registró ninguno.
  vehicle: driverVehicle.nullable(),
  documents: z.array(adminDriverDocument),
  /**
   * READINESS de aprobación NO-biométrico (documental + ITV) REFLEJADO del gate server-side de `approve()`.
   * Lo calcula el admin-bff con la MISMA lógica que IMPONE al aprobar (single source of truth) → el panel
   * muestra exactamente qué falta y NO habilita "Aprobar" a ciegas. La UI refleja, el servidor decide.
   *  - documentsValid: TODOS los docs obligatorios están VALID. missingDocuments: los que faltan/no-válidos.
   *  - inspection.current: la ITV del vehículo operado está vigente (passed && no vencida). invalidReason
   *    (NONE/NOT_PASSED/OVERDUE/NO_VEHICLE · null si vigente) explica POR QUÉ no, para el hint del operador.
   */
  approvalReadiness: z.object({
    documentsValid: z.boolean(),
    missingDocuments: z.array(z.string()),
    inspection: z.object({
      current: z.boolean(),
      invalidReason: z.string().nullable(),
      nextDueAt: z.string().nullable(),
      hasVehicle: z.boolean(),
      // Vehículo OPERADO contra el que se evalúa la ITV (mismo selector que el gate). El panel lo usa para
      // precargar el alta de inspección inline. null si el conductor no tiene vehículo operable.
      vehicleId: z.string().nullable(),
    }),
  }),
  /**
   * CAUSAS ACTIVAS de la suspensión (modelo de HOLDS, derivado en identity): las `cause` distintas de los
   * holds vigentes (DISCIPLINARY / DOCUMENT_EXPIRED / INSPECTION_EXPIRED). [] si NO está suspendido. El panel
   * lo usa para saber POR QUÉ está suspendido y llamar el endpoint correcto: DISCIPLINARY → /reactivate;
   * DOCUMENT_EXPIRED/INSPECTION_EXPIRED → /reactivate-compliance. Si hay VARIAS causas, las muestra todas.
   */
  suspensionCauses: z.array(z.string()),
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
  // `active` = este recargo (B4) es el que HOY afecta la tarifa. Es el inverso exacto de
  // `energyCatalogView.active`: el flag de servidor PRICING_ENERGY_MODEL_ENABLED elige UN solo
  // modelo de energía vivo (OFF → combustible B4; ON → catálogo de energía B5). El panel lo refleja
  // (badge Activo / Vista previa) — la UI nunca decide cuál manda, lo lee del server.
  active: z.boolean(),
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
 * Tarifa base vigente (GET /pricing/base-fare · F2.4): banderazo + per-km + per-min en céntimos PEN.
 * Reemplaza los escalares hardcodeados de la fórmula de tarifa; el admin los edita en caliente.
 */
export const baseFareView = z.object({
  baseFareCents: z.number().int().nonnegative(),
  perKmCents: z.number().int().nonnegative(),
  perMinCents: z.number().int().nonnegative(),
  version: z.number().int(),
  updatedAt: z.string(),
});
export type BaseFareView = z.infer<typeof baseFareView>;

/**
 * Body del PUT /pricing/base-fare (F2.4): los tres componentes base en céntimos PEN. `expectedVersion` =
 * optimistic locking (CAS): la versión que el panel cargó; el server reemplaza solo si sigue vigente, si
 * otro admin la movió responde 409 (el panel recarga y reintenta). 0 = primer write.
 */
export const replaceBaseFareRequest = z.object({
  baseFareCents: z.number().int().nonnegative(),
  perKmCents: z.number().int().nonnegative(),
  perMinCents: z.number().int().nonnegative(),
  expectedVersion: z.number().int().nonnegative(),
});
export type ReplaceBaseFareRequest = z.infer<typeof replaceBaseFareRequest>;

/**
 * Comisión por modo vigente (GET /finance/commission · F2.7 · ADR-017 §1.6 / ADR-015 §11.2). Las tasas van en
 * BASIS POINTS Int (0..10000; 2000 = 20%) — NUNCA float. AMBAS configurables: la comisión ON-DEMAND (descontada
 * al conductor) y el service fee CARPOOLING (sumado al pasajero en cost-sharing).
 */
export const commissionView = z.object({
  onDemandRateBps: z.number().int().min(0).max(10_000),
  carpoolingFeeBps: z.number().int().min(0).max(10_000),
  version: z.number().int(),
  updatedAt: z.string(),
});
export type CommissionView = z.infer<typeof commissionView>;

/**
 * Body del PUT /finance/commission (F2.7): AMBAS tasas en basis points Int (full-replace). `expectedVersion` =
 * CAS (la versión que el panel cargó; 409 si otro admin la movió → recargar).
 */
export const replaceCommissionRequest = z.object({
  onDemandRateBps: z.number().int().min(0).max(10_000),
  carpoolingFeeBps: z.number().int().min(0).max(10_000),
  expectedVersion: z.number().int().nonnegative(),
});
export type ReplaceCommissionRequest = z.infer<typeof replaceCommissionRequest>;

/**
 * Costo de OPERACIÓN por km del carpooling, por país (GET /finance/cost-per-km · F2.5 · escudo legal). Es el
 * costo real de operar el vehículo (combustible + desgaste, estilo "IRS mileage rate") en CÉNTIMOS PEN Int —
 * NUNCA float, NO derivado del precio de energía. Lo fija el admin y alimenta DIRECTO el tope de cost-sharing.
 */
export const costPerKmConfigView = z.object({
  pais: z.enum(['PE', 'EC']),
  costPerKmCents: z.number().int().positive(),
  version: z.number().int(),
  updatedAt: z.string(),
});
export type CostPerKmConfigView = z.infer<typeof costPerKmConfigView>;

/** GET /finance/cost-per-km: una fila por país (PE/EC). */
export const costPerKmListView = z.object({
  configs: z.array(costPerKmConfigView),
});
export type CostPerKmListView = z.infer<typeof costPerKmListView>;

/**
 * Cobro REEMBOLSABLE de un viaje (GET /finance/payments/by-trip/:tripId). El operador de finanzas lo consulta
 * ANTES de reembolsar: es EXACTAMENTE el pago que el POST /finance/refunds/:tripId tocaría (mismo lookup
 * kind=FARE, CAPTURED/PARTIALLY_REFUNDED, el más reciente). `refundableCents = amountCents − refundedCents`
 * (saldo que aún se puede devolver). Dinero SIEMPRE Int céntimos (formatear a S/ SOLO en la UI).
 * RECORTA la PII de riel (externalRef/payerRef/externalUid/checkoutUrl/qr/cip NO viajan); los ids de personas y
 * los montos SÍ son PII → el acceso queda auditado (payment.view_by_trip) tras el gate FINANCE en el admin-bff.
 */
export const refundablePaymentView = z.object({
  paymentId: z.string(),
  tripId: z.string(),
  driverId: z.string().nullable(),
  passengerId: z.string().nullable(),
  method: mobilePaymentMethod,
  status: paymentStatus,
  currency: z.string(),
  grossCents: z.number().int(),
  amountCents: z.number().int(),
  refundedCents: z.number().int().nonnegative(),
  refundableCents: z.number().int().nonnegative(),
  discountCents: z.number().int().nonnegative(),
  creditCents: z.number().int().nonnegative(),
  tipCents: z.number().int().nonnegative(),
  capturedAt: z.string().nullable(),
  refundedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type RefundablePaymentView = z.infer<typeof refundablePaymentView>;

/**
 * Body del PUT /finance/cost-per-km (F2.5): el costo/km de UN país en céntimos PEN Int. `expectedVersion` =
 * CAS per-país (409 si otro admin lo movió → recargar). El peaje NO va acá: lo declara el conductor por viaje.
 */
export const replaceCostPerKmRequest = z.object({
  pais: z.enum(['PE', 'EC']),
  costPerKmCents: z.number().int().positive().max(10_000),
  expectedVersion: z.number().int().nonnegative(),
});
export type ReplaceCostPerKmRequest = z.infer<typeof replaceCostPerKmRequest>;

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
  // `active` = este catálogo (B5) es el que HOY afecta la tarifa (flag PRICING_ENERGY_MODEL_ENABLED
  // ON). Inverso de `fuelSurchargeView.active`. Mientras esté en false, editar acá NO mueve la tarifa
  // (queda guardado para el día del flip) — el panel lo dice explícito (badge Vista previa).
  active: z.boolean(),
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
  // EJE 1 (B5) · la VERTICAL del servicio: RIDE (las ofertas de viaje) vs verticales especiales
  // (AMBULANCE/TOW/MECHANIC, flujo propio, solo FIXED). El panel agrupa por esto (CALIDAD/CAPACIDAD vs
  // SERVICIOS ESPECIALES). Literal desacoplado de shared-types, igual que `vehicleClass`.
  serviceType: z.enum(['RIDE', 'AMBULANCE', 'TOW', 'MECHANIC']),
  sortOrder: z.number().int(),
  enabled: z.boolean(),
  allowedModes: z.array(pricingMode),
  pricing: offeringPricing,
  // EJE de CAPACIDAD (B5-3): `minSeats` distingue una oferta por TAMAÑO (VEO XL = 6 asientos) de las de
  // CALIDAD/confort. Es lo único que el panel necesita del bloque `requires` para separar los dos ejes; el
  // resto de requisitos (segmento/antigüedad/certs) son del matching, no del agrupado de la UI.
  requires: z.object({ minSeats: z.number().int().positive().optional() }).optional(),
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
  // Tope de cordura: espeja MULTIPLIER_MAX (=10) del DTO autoritativo de trip-service (el contrato se mantiene
  // desacoplado de shared-types, por eso el literal). Corta el dedazo ×100; trip-service RE-valida con @Max.
  multiplier: z.number().positive().max(10).optional(),
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

/* ── Dispatch: config de RADIOS (k-rings) + VENTANAS singleton global ── */

/**
 * Config de dispatch vigente (GET /admin/dispatch/radius-config): k-rings + ventanas + versión + sello.
 * `offerTimeoutMs` = ventana de la oferta directa FIXED (ms); `bidWindowSec` = ventana del board de PUJA (s).
 */
export const dispatchRadiusConfigView = z.object({
  nearbyKRing: z.number().int().min(1).max(8),
  matchKRing: z.number().int().min(1).max(8),
  offerTimeoutMs: z.number().int().min(5_000).max(120_000),
  bidWindowSec: z.number().int().min(15).max(300),
  version: z.number().int(),
  updatedAt: z.string(),
});
export type DispatchRadiusConfigView = z.infer<typeof dispatchRadiusConfigView>;

/** Body del PUT /admin/dispatch/radius-config: REEMPLAZA k-rings + ventanas (bump version aguas abajo). */
export const replaceRadiusConfigRequest = z.object({
  nearbyKRing: z.number().int().min(1).max(8),
  matchKRing: z.number().int().min(1).max(8),
  offerTimeoutMs: z.number().int().min(5_000).max(120_000),
  bidWindowSec: z.number().int().min(15).max(300),
});
export type ReplaceRadiusConfigRequest = z.infer<typeof replaceRadiusConfigRequest>;

/* ── Finanzas: resultado del disparo de la liquidación (POST /finance/payouts/run · ADR-015 §5) ──
 * El operador AGREGA + DESEMBOLSA el período. El desembolso es ASÍNCRONO: `dispatched` = payouts que
 * entraron a PROCESSING (el riel aceptó el desembolso, la plata está EN CAMINO — confirma luego por
 * webhook/poll); `failed` = rechazados en línea por el riel. NO es "pagadas": PROCESSED se alcanza recién
 * cuando el riel confirma la salida del dinero. */
export const runPayoutsResult = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  dispatched: z.number().int(),
  failed: z.number().int(),
  totalAmountCents: z.number().int(),
});
export type RunPayoutsResult = z.infer<typeof runPayoutsResult>;

/* ── Finanzas: resultado del REINTENTO de un payout FALLIDO (POST /finance/payouts/:id/retry · ADR-015 §5) ──
 * Es por-payout (no por-período), así que la respuesta NO trae periodStart/periodEnd — solo el desembolso:
 * `dispatched` = entró a PROCESSING (el riel aceptó, plata EN CAMINO); `failed` = rechazado en línea. */
export const payoutDisburseResult = z.object({
  dispatched: z.number().int(),
  failed: z.number().int(),
  totalAmountCents: z.number().int(),
});
export type PayoutDisburseResult = z.infer<typeof payoutDisburseResult>;

/* ── Flota: vehículos, inspecciones, vencimientos ── */
export const vehicleView = z.object({
  id: z.string(),
  plate: z.string(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  year: z.number().int().nullable(),
  color: z.string().nullable(),
  status: z.string(),
  // Operabilidad DERIVADA (Lote 4): el MISMO veredicto que gatea el match (docs SOAT/ITV operables Y ficha
  // linkeada Y docStatus !== EXPIRED) — la fuente que consume el gRPC (booking/dispatch). El panel la muestra como
  // OPERABLE/NO OPERABLE; `operabilityReason` da el PORQUÉ (DOCS/NO_SPEC, server-side · null si opera) — la UI lo
  // ETIQUETA, no re-deriva la regla (mata el magic string que antes recomponía el motivo desde docStatus).
  operable: z.boolean(),
  operabilityReason: vehicleOperabilityReason.nullable(),
  driverId: z.string().nullable(),
  // Ficha técnica del MATCH vehículo↔config. El dispatch gatea la eligibilidad de oferta con segment + seats
  // (+ el `year` de arriba); energySource/efficiency se MUESTRAN pero NO deciden match ni pricing (el precio de
  // energía sale de la clase de la oferta · ADR-017 dec.2). Tipo/categoría viven en el Vehicle; el resto del
  // modelSpec elegido. Null = vehículo legacy sin modelSpec o categoría no leída (degradación honesta → "—").
  vehicleType: z.string().nullable(),
  mtcCategory: z.string().nullable(),
  segment: z.string().nullable(),
  energySource: z.string().nullable(),
  efficiency: z.number().int().nullable(),
  seats: z.number().int().nullable(),
  /** Nombre del conductor dueño (User.id → name · Compliance+); null redactado para sub-Compliance o sin dato. */
  driverName: z.string().nullable(),
  /** Estado de ITV (última inspección del vehículo) para la columna "ITV": `itvCurrent` = vigente (aprobada y no
   *  vencida); `itvNextDueAt` = próximo vencimiento (para "Vence N días"); `itvHasInspection` = si tiene alguna. */
  itvHasInspection: z.boolean(),
  itvCurrent: z.boolean(),
  itvNextDueAt: z.string().nullable(),
  /** ISO-8601 de alta del vehículo (encolado para el SLA de la cola de Revisiones); null si sin dato. */
  createdAt: z.string().nullable(),
});
export type VehicleView = z.infer<typeof vehicleView>;

/** Conteo de vehículos por estado documental (embudo de vigencia · stat cards del panel). */
export const vehicleCounts = z.object({
  valid: z.number().int(),
  expiringSoon: z.number().int(),
  expired: z.number().int(),
});
export type VehicleCounts = z.infer<typeof vehicleCounts>;

/** Conteo de las colas de revisión (cola unificada de Revisiones): conductores pendientes de aprobación +
 *  documentos por revisar/por vencer + modelos por curar. Agregado de identity + fleet. Sin PII. */
export const reviewQueueSummary = z.object({
  driversPending: z.number().int(),
  docsPendingReview: z.number().int(),
  docsExpiringSoon: z.number().int(),
  modelsPendingReview: z.number().int(),
});
export type ReviewQueueSummary = z.infer<typeof reviewQueueSummary>;

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
  energySource: z.enum(['GASOLINE_90', 'DIESEL', 'ELECTRIC']),
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

/**
 * Resultado de pedir el stream de un video aprobado (BR-S02 · burn-in Lote 3). DISCRIMINADO por `status`:
 *  - PROCESSING: la copia con watermark QUEMADO se está rindiendo server-side (asíncrono). NO hay URL aún;
 *    el cliente reintenta (poll). El operador NUNCA recibe la URL del video crudo.
 *  - READY: copia lista → `url` firmada (5 min) de la COPIA DERIVADA + `watermark` ya quemado + vencimiento.
 * Tiparlo como unión discriminada (no un objeto con campos opcionales) hace que el cliente DEBA estrechar
 * por `status` antes de tocar `url` — no se puede reproducir por accidente un PROCESSING sin URL.
 */
export const signedMedia = z.discriminatedUnion('status', [
  z.object({ status: z.literal('PROCESSING') }),
  z.object({
    status: z.literal('READY'),
    url: z.string(),
    expiresAt: z.string(),
    watermark: z.string(),
    segmentId: z.string(),
  }),
]);
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
