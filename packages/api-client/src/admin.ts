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
  adminTripStatus,
  driverSummary,
  fleetDocumentStatus,
  vehicleOperabilityReason,
  documentSide,
} from './types.js';
import {
  pricingMode,
  paymentStatus,
  mobilePaymentMethod,
  // Enums del PublishedTrip (fuente única): el detalle admin del carpool los reusa (no los redefine).
  publishedTripState,
  carpoolModoReserva,
} from './mobile.js';

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
  /** Margen neto de la plataforma HOY (comisión − fee PSP · payment-service). KPI "Margen hoy". */
  platformMarginTodayCents: z.number().int(),
  /** Viajes digitales de HOY (cobros FARE capturados desde medianoche Lima). KPI "Viajes hoy". */
  tripCountToday: z.number().int(),
  /** Ticket promedio de HOY (derivado = revenueTodayCents / tripCountToday; 0 sin viajes). KPI "Ticket hoy". */
  avgTicketTodayCents: z.number().int(),
  /** Tasa de cancelación de HOY (derivada; null sin cierres). KPI "Cancelación hoy" (fracción, 0.05 = 5%). */
  cancellationRateToday: z.number().nullable(),
  avgDurationSeconds: z.number().nullable(),
  /** Viajes de HOY por MODO 3-way (FIXED | PUJA | CARPOOLING · payment-service, mismo bucketing que el
   *  revenue-por-modo). Alimenta el donut "Modos de servicio · viajes de hoy". [] si payment cae o no hay data. */
  byMode: z.array(z.object({ mode: z.string(), trips: z.number().int() })),
  series: z.array(overviewSeriesPoint),
});
export type AnalyticsOverview = z.infer<typeof analyticsOverview>;

/* ── Analytics revenue por rango (/analytics/revenue?range=today|7d|30d · pantalla "Métricas") ── */

/**
 * Rango temporal de las métricas de revenue. Enum del CONTRATO (fuente única del literal): el admin-bff valida el
 * query contra esto y payment-service lo re-estrecha. `today` = desde medianoche Lima; `7d`/`30d` = últimos 7/30
 * días naturales (TZ America/Lima). Tiparlo como enum mata el magic string: comparar fuera del set es error de compilación.
 */
export const revenueRange = z.enum(['today', '7d', '30d', '90d']);
export type RevenueRangeValue = z.infer<typeof revenueRange>;

/**
 * Un punto de la serie de revenue: `revenueCents` = money-in NETO al banco (Σ netSettled) del bucket. `bucket` es
 * la hora local de Lima (ISO-naïve 'YYYY-MM-DDTHH:00:00') si `range=today`, o el día ('YYYY-MM-DD') si `7d`/`30d`.
 */
export const revenueSeriesPoint = z.object({
  bucket: z.string(),
  revenueCents: z.number().int(),
});
export type RevenueSeriesPoint = z.infer<typeof revenueSeriesPoint>;

/**
 * Métricas de revenue del rango para la pantalla "Métricas". Todo en céntimos Int (PEN). `moneyInCents` = plata
 * digital liquidada que entró al banco; `grossCommissionCents` = comisión bruta de la plataforma sobre esos viajes;
 * `refundedCents` = total reembolsado en el rango; `platformMarginCents = grossCommissionCents − refundedCents`
 * (margen neto, lo DERIVA el admin-bff). `series` reconcilia con `moneyInCents` (misma definición de money-in).
 */
/** Revenue por MODO 3-way (FIXED | PUJA | CARPOOLING): payment divide el ON_DEMAND por el `dispatchMode`
 *  denormalizado del viaje; CARPOOLING es el eje `Payment.mode`. `revenueCents` = Σ netSettled. */
export const revenueByModePoint = z.object({
  mode: z.string(),
  revenueCents: z.number().int(),
});
export type RevenueByModePoint = z.infer<typeof revenueByModePoint>;

/** Revenue por DISTRITO de origen (payment zonifica lat/lng→distrito de Lima en la captura). `revenueCents` = Σ
 *  netSettled. Distritos sin geo / fuera de cobertura NO aparecen (degradación honesta). Ordenado desc. */
export const revenueByDistrictPoint = z.object({
  district: z.string(),
  revenueCents: z.number().int(),
});
export type RevenueByDistrictPoint = z.infer<typeof revenueByDistrictPoint>;

/**
 * Variación % vs el período PREVIO (misma duración, ventana inmediatamente anterior). `null` cuando el período
 * previo no tiene base (0) — NO se inventa un %: la UI muestra el KPI sin delta. Fracción (0.18 = +18%).
 */
export const revenueDeltas = z.object({
  moneyInPct: z.number().nullable(),
  tripCountPct: z.number().nullable(),
  avgTicketPct: z.number().nullable(),
});
export type RevenueDeltas = z.infer<typeof revenueDeltas>;

export const revenueMetricsView = z.object({
  range: revenueRange,
  moneyInCents: z.number().int(),
  grossCommissionCents: z.number().int(),
  refundedCents: z.number().int(),
  platformMarginCents: z.number().int(),
  /** Viajes digitales capturados (kind=FARE) del rango → habilita "Viajes" y "Ticket promedio". */
  tripCount: z.number().int(),
  /** Ticket promedio derivado = moneyInCents / tripCount (0 si no hay viajes). */
  avgTicketCents: z.number().int(),
  /** Revenue por modo 3-way (Fijo/Puja/Carpooling) → donut "Ingresos por modo". */
  byMode: z.array(revenueByModePoint),
  /** Revenue por distrito de origen (zonificado), ordenado desc → "Top distritos por ingreso". [] si sin data. */
  topDistricts: z.array(revenueByDistrictPoint),
  /** Variación % vs período previo (null sin base). */
  deltas: revenueDeltas,
  series: z.array(revenueSeriesPoint),
});
export type RevenueMetricsView = z.infer<typeof revenueMetricsView>;

/* ── Detalle de viaje (/trips/:id) ── */
export const tripDetail = tripSummary.extend({
  origin: geoPoint.nullable(),
  destination: geoPoint.nullable(),
  /**
   * Direcciones legibles de origen/destino (reverse-geocode SOBERANO en el bff · @veo/maps self-hosted).
   * `null` si el rol no ve la geo exacta (misma gate que origin/destination), si no hubo match o si el
   * geocoder está caído — degradación honesta: la UI cae a las coordenadas, nunca inventa una dirección.
   */
  originLabel: z.string().nullable(),
  destinationLabel: z.string().nullable(),
  driverLocation: geoPoint.nullable(),
  routePolyline: z.string().nullable(),
  etaSeconds: z.number().int().nullable(),
  /** Duración REAL del viaje en segundos (Trip.durationSeconds persistido); null si aún no se conoce. Es el
   *  tiempo del viaje — distinto de `etaSeconds` (ETA EN VIVO al destino, null en viajes terminados). */
  durationSeconds: z.number().int().nullable(),
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
  /** Teléfono del pasajero (identity, PII → null para sub-Compliance). Para la acción "Contactar pasajera". */
  passengerPhone: z.string().nullable(),
  driverId: z.string().nullable(),
  driverName: z.string().nullable(),
  status: z.string(),
  geo: geoPoint,
  triggeredAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  acknowledgedBy: z.string().nullable(),
  /** Respuesta operativa (acciones laterales; no cambian el status): despacho de unidad / escalación a
   *  autoridades — timestamp del sello (ISO) para la línea de tiempo + estado de los botones. */
  dispatchedAt: z.string().nullable(),
  escalatedAt: z.string().nullable(),
  notes: z.string().nullable(),
  evidence: z.array(
    z.object({ id: z.string(), kind: z.string(), label: z.string(), at: z.string() }),
  ),
});
export type PanicDetail = z.infer<typeof panicDetail>;

/**
 * Body del POST /security/panics/:id/resolve: DESENLACE del incidente (RESOLVED = atendido/resuelto,
 * FALSE_ALARM = falsa alarma) + un motivo OPCIONAL que se registra en el audit (Ley 29733 · rendición de
 * cuentas). Espejo de `ResolvePanicDto` del admin-bff (`resolution` requerido con @IsIn, `notes` opcional).
 */
export const resolvePanicRequest = z.object({
  resolution: z.enum(['RESOLVED', 'FALSE_ALARM']),
  notes: z.string().max(2000).optional(),
});
export type ResolvePanicRequest = z.infer<typeof resolvePanicRequest>;

/**
 * Body del POST /security/panics/:id/evidence: claves S3 de la evidencia a adjuntar al incidente y,
 * opcionalmente, `finalize` para PROTEGERLAS con retención/object-lock (cadena de custodia · Ley 29733).
 * Espejo de `PanicEvidenceDto` del admin-bff (que re-valida: 1..50 claves, cada una string).
 */
export const attachPanicEvidenceRequest = z.object({
  keys: z.array(z.string().min(1)).min(1).max(50),
  finalize: z.boolean().optional(),
});
export type AttachPanicEvidenceRequest = z.infer<typeof attachPanicEvidenceRequest>;

/** Respuesta del POST /security/panics/:id/evidence: claves adjuntas + las que quedaron protegidas. */
export const panicEvidenceResult = z.object({
  evidenceS3Keys: z.array(z.string()),
  protectedKeys: z.array(z.string()),
});
export type PanicEvidenceResult = z.infer<typeof panicEvidenceResult>;

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
  /**
   * Presencia OPERATIVA real del conductor para la columna ESTADO (En línea/Offline): el `currentStatus`
   * AUTORITATIVO de identity (OFFLINE/AVAILABLE/ASSIGNED/ON_TRIP/ON_BREAK/SUSPENDED), enriquecido on-read.
   * Es un EJE DISTINTO del `status` de ciclo de vida (PENDING/ACTIVE/REJECTED/SUSPENDED que proyecta el
   * read-model por eventos): un postulante PENDING está OFFLINE, no "en línea". No es PII (el detalle ya lo
   * expone) → para todos los roles. `null` cuando la fuente no la trae (la cola de pendientes no la proyecta).
   */
  operationalStatus: z.string().nullable(),
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
  /** Conductores EN LÍNEA (presencia operativa real: current_status NO OFFLINE ni SUSPENDED) → KPI "En línea". */
  online: z.number().int(),
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

/** Un operador del panel tal como lo lista GET /ops/operators (gestión de staff · ADMIN/SUPERADMIN).
 *  La tabla del panel muestra por fila: Nombre (`name`), 2FA (`totpEnrolled`) y Último acceso (`lastLoginAt`),
 *  además del email/estado/roles/alta. Los tres nuevos salen de la MISMA fuente que el detalle (identity). */
export const operator = z.object({
  id: z.string(),
  email: z.string(),
  /** Nombre legible del operador (columna "Nombre"). null si el alta por invitación aún no lo capturó. */
  name: z.string().nullable(),
  status: operatorStatus,
  roles: z.array(z.string()),
  /** ¿Enroló su segundo factor (TOTP)? Columna "2FA". */
  totpEnrolled: z.boolean(),
  /** ISO-8601 del último login EXITOSO (columna "Último acceso"); null si nunca ingresó. */
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Operator = z.infer<typeof operator>;

/**
 * Una SESIÓN activa del operador (pantalla de detalle · gestión de acceso). Las sesiones viven en Redis
 * (refresh-store); NO hay device/UA/geo almacenados, así que se expone SOLO `id` + `lastActiveAt` (última
 * rotación/actividad de la sesión). El operador ADMIN puede revocar una sesión puntual desde el detalle.
 */
export const operatorSession = z.object({
  id: z.string(),
  lastActiveAt: z.string(),
});
export type OperatorSession = z.infer<typeof operatorSession>;

/**
 * Detalle de un operador (GET /ops/operators/:id · pantalla "Detalle de operador"). Extiende la fila de la
 * lista (hereda name/totpEnrolled/lastLoginAt) con:
 *  - `effectivePermissions`: los permisos que sus roles le conceden según la matriz BASE (`PERMISSION_ROLES`
 *    de @veo/policy). Es per-TARGET (el operador mirado), NO per-viewer: el overlay/hidden es del ACTOR que
 *    mira, no del operador objetivo → acá se usa la base pura (lo que ese operador PUEDE por sus roles).
 *  - `sessions`: sus sesiones activas (para revisarlas/revocarlas).
 */
export const operatorDetail = operator.extend({
  effectivePermissions: z.array(z.string()),
  sessions: z.array(operatorSession),
});
export type OperatorDetail = z.infer<typeof operatorDetail>;

/** Body del POST /ops/operators/:id/roles: reemplaza los roles RBAC del operador. Step-up MFA + anti-escalada.
 *  `roles` como `string[]` (contrato del wire); el admin-bff RE-valida cada uno contra `AdminRole` server-side. */
export const changeOperatorRolesRequest = z.object({
  roles: z.array(z.string()).min(1),
});
export type ChangeOperatorRolesRequest = z.infer<typeof changeOperatorRolesRequest>;

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

/* ── Pricing: modo de despacho PUJA↔FIJO ──
 * ADR 023 (supersedes ADR 011): el schedule/franjas horarias del modo se RETIRÓ. El modo vive POR OFERTA
 * (`catalogOffering.mode` + `catalogOverride.mode` = la palanca manual del admin, más abajo); ya NO existe
 * el endpoint `/pricing/mode-schedule` (trip-service lo eliminó → un cliente que lo llame daría 404). Por
 * eso se borraron `ModeScheduleView`/`ReplaceScheduleRequest`/`PricingModeRule`. `pricingMode` sigue
 * reutilizándose de ./mobile (fuente única del enum) en la sección de catálogo.
 */

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
  /** CAS de la comisión on-demand (+ fees PSP). El panel on-demand la usa como `expectedVersion`. */
  version: z.number().int(),
  /** CAS INDEPENDIENTE del service fee de carpooling. El panel de carpooling la usa como `expectedVersion`. */
  carpoolingFeeVersion: z.number().int(),
  updatedAt: z.string(),
});
export type CommissionView = z.infer<typeof commissionView>;

/**
 * Body del PUT /finance/commission/on-demand (F2.7 · CAS desacoplada #3): SOLO la comisión on-demand en bps Int.
 * `expectedVersion` = la `version` que el panel cargó (409 si otro admin la movió → recargar). Editar esto ya NO
 * 409ea el panel de carpooling (cada uno tiene su propia CAS).
 */
export const replaceOnDemandRateRequest = z.object({
  onDemandRateBps: z.number().int().min(0).max(10_000),
  expectedVersion: z.number().int().nonnegative(),
});
export type ReplaceOnDemandRateRequest = z.infer<typeof replaceOnDemandRateRequest>;

/**
 * Body del PUT /finance/commission/carpooling-fee (F2.7 · CAS desacoplada #3): SOLO el service fee de carpooling
 * en bps Int. `expectedVersion` = la `carpoolingFeeVersion` que el panel cargó (INDEPENDIENTE de la de on-demand;
 * 409 si otro admin la movió → recargar).
 */
export const replaceCarpoolingFeeRequest = z.object({
  carpoolingFeeBps: z.number().int().min(0).max(10_000),
  expectedVersion: z.number().int().nonnegative(),
});
export type ReplaceCarpoolingFeeRequest = z.infer<typeof replaceCarpoolingFeeRequest>;

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

/* ── Cola de aprobación de REEMBOLSOS (money-OUT · frame HZ8uz) ──────────────────────────────────────────
 * Máquina de estados del Refund (enum Prisma `RefundStatus`):
 *   PENDING   → solicitado por un operador, AÚN NO desembolsado (espera aprobación). Es la cola.
 *   APPROVED  → aprobado y con el desembolso EN EL RIEL (reserva tomada; espera confirmación del proveedor,
 *               o transitorio para CASH/confirmación síncrona que salta a COMPLETED).
 *   COMPLETED → la plata volvió (confirmada por el proveedor o devolución local de efectivo).
 *   REJECTED  → rechazado por el operador (solicitud PENDING, sin mover plata) o por el proveedor (reverso
 *               APPROVED rechazado → reserva compensada). Terminal.
 * Los refunds de SISTEMA (booking.cancelled) y las propinas revertidas NACEN en APPROVED (auto-aprobados, no
 * bloquean cancelaciones); SOLO los admin-iniciados entran a la cola PENDING con approval-gate. */
export const refundStatus = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'COMPLETED']);
export type RefundStatusValue = z.infer<typeof refundStatus>;

/**
 * Fila de la cola de reembolsos (GET /finance/refunds). Los datos del cobro (tripId, passengerId, method) salen
 * del Payment ligado por FK; `passengerName` lo resuelve identity gateado por PII (Ley 29733: un FINANCE puro no
 * ve identidad → null). Dinero SIEMPRE Int céntimos (formatear a S/ SOLO en la UI). `requestedBy`/`approvedBy` son
 * ids de operador (o 'system' para los auto-refunds). `failureReason` = motivo del rechazo (operador o proveedor).
 */
export const refundView = z.object({
  id: z.string(),
  paymentId: z.string(),
  tripId: z.string(),
  passengerId: z.string().nullable(),
  passengerName: z.string().nullable(),
  amountCents: z.number().int(),
  currency: z.string(),
  method: mobilePaymentMethod,
  reason: z.string(),
  status: refundStatus,
  requestedBy: z.string(),
  approvedBy: z.string().nullable(),
  failureReason: z.string().nullable(),
  requestedAt: z.string(),
  updatedAt: z.string(),
});
export type RefundView = z.infer<typeof refundView>;

/** Detalle de un reembolso (GET /finance/refunds/:id): la fila de la cola + el saldo del cobro para contexto. */
export const refundDetailView = refundView.extend({
  paymentStatus,
  paymentAmountCents: z.number().int(),
  paymentRefundedCents: z.number().int().nonnegative(),
  refundableCents: z.number().int().nonnegative(),
  externalRefundId: z.string().nullable(),
});
export type RefundDetailView = z.infer<typeof refundDetailView>;

/**
 * KPIs de la cabecera de la cola (GET /finance/refunds/stats). `refundRatePct` = % de cobros capturados que
 * terminaron reembolsados (derivable); null si no hay cobros capturados aún (degradación honesta, no se inventa).
 */
export const refundStatsView = z.object({
  requestedCount: z.number().int().nonnegative(),
  approvedCount: z.number().int().nonnegative(),
  processedTodayCents: z.number().int().nonnegative(),
  refundRatePct: z.number().nonnegative().nullable(),
});
export type RefundStatsView = z.infer<typeof refundStatsView>;

/** Resultado de una acción sobre la cola (crear/aprobar/rechazar): id del refund + el estado resultante. */
export const refundActionResult = z.object({
  refundId: z.string(),
  paymentId: z.string(),
  status: refundStatus,
});
export type RefundActionResult = z.infer<typeof refundActionResult>;

/** Body del POST /finance/refunds/:id/reject: motivo del rechazo (textarea del RejectModal, se persiste). */
export const rejectRefundRequest = z.object({
  reason: z.string().min(3),
});
export type RejectRefundRequest = z.infer<typeof rejectRefundRequest>;

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

/* ── Piso de la PUJA (bid floor) per-oferta · ADR 010 §9.3 ── */

/** Un override del piso para una OFERTA. `offeringId` viaja como string (enum del dominio). */
export const bidFloorOverride = z.object({
  offeringId: z.string(),
  floorCents: z.number().int().nonnegative(),
});
export type BidFloorOverride = z.infer<typeof bidFloorOverride>;

/** Piso vigente (GET /pricing/bid-floor): piso por defecto + overrides por oferta + versión. */
export const bidFloorView = z.object({
  defaultFloorCents: z.number().int().nonnegative(),
  overrides: z.array(bidFloorOverride),
  version: z.number().int(),
  updatedAt: z.string(),
});
export type BidFloorView = z.infer<typeof bidFloorView>;

/**
 * Body del PUT /pricing/bid-floor (ADR 010 §9.3): piso por defecto + overrides por oferta.
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
 * Una oferta del catálogo efectivo (GET /catalog): tokens de display + estado configurable. ADR 023: el modo
 * vive POR OFERTA — `mode` es el modo EFECTIVO (base de código ⟕ palanca manual del admin, ya resuelto
 * server-side) y `modeLocked` dice si el admin PUEDE cambiarlo (las verticales especiales van locked: "la
 * ambulancia NO negocia"). El panel pinta el select del modo habilitado/deshabilitado según `modeLocked` y
 * refleja `mode` como el valor vigente. `pricing` es el EFECTIVO (lo que se cobra hoy). Reemplaza el par
 * `allowedModes`/`modePin` (ADR 011, superseded): ya no hay schedule.
 */
export const catalogOffering = z.object({
  id: z.string(),
  labelKey: z.string(),
  icon: z.string(),
  // ADR 013 · ofertas CUSTOM (alta del admin): traen su `name` display (no hay clave i18n) e `isCustom:true`.
  // Ausentes en las built-in (el panel resuelve su nombre por el map de `offeringLabel`). El panel prefiere
  // `name` cuando está y cae a `offeringLabel(id)` si no.
  name: z.string().optional(),
  isCustom: z.boolean().optional(),
  vehicleClass: z.enum(['CAR', 'MOTO']),
  // EJE 1 (B5) · la VERTICAL del servicio: RIDE (las ofertas de viaje) vs verticales especiales
  // (AMBULANCE/TOW/MECHANIC, flujo propio, solo FIXED). El panel agrupa por esto (CALIDAD/CAPACIDAD vs
  // SERVICIOS ESPECIALES). Literal desacoplado de shared-types, igual que `vehicleClass`.
  serviceType: z.enum(['RIDE', 'AMBULANCE', 'TOW', 'MECHANIC']),
  sortOrder: z.number().int(),
  enabled: z.boolean(),
  // ADR 023 · modo EFECTIVO de la oferta (PUJA/FIXED), resuelto server-side (código ⟕ pin del admin).
  mode: pricingMode,
  // ADR 023 · true = el admin NO puede cambiar el modo (invariante de dominio: verticales especiales). El
  // panel deshabilita el select cuando es true. Reemplaza el candado que antes daba `allowedModes`.
  modeLocked: z.boolean(),
  pricing: offeringPricing,
  // EJE de CAPACIDAD (B5-3): `minSeats` distingue una oferta por TAMAÑO (VEO XL = 6 asientos) de las de
  // CALIDAD/confort. Es lo único que el panel necesita del bloque `requires` para separar los dos ejes; el
  // resto de requisitos (segmento/antigüedad/certs) son del matching, no del agrupado de la UI.
  requires: z.object({ minSeats: z.number().int().positive().optional() }).optional(),
});
export type CatalogOffering = z.infer<typeof catalogOffering>;

/**
 * Override CRUDO de una oferta (lo que el admin tiene seteado explícitamente). B1: enabled. B2: mode
 * (pin), multiplier, minFareCents. ADR 023 §3: params por-servicio `baseFareCents`/`perKmCents`/`perMinCents`
 * (banderazo/por-km/por-min por oferta). Todos OPCIONALES; ausentes → el valor de código (que a su vez, si es
 * `undefined`, cae al default GLOBAL de la tarifa base). Es el shape que viaja en AMBOS sentidos: GET /catalog
 * lo devuelve (overlay actual) y PUT /catalog lo reemplaza wholesale. Los topes de cordura ESPEJAN los del DTO
 * autoritativo de trip-service (contrato desacoplado de shared-types → literales); trip-service RE-valida.
 */
export const catalogOverride = z.object({
  id: z.string(),
  enabled: z.boolean(),
  mode: pricingMode.optional(),
  // Tope de cordura: espeja MULTIPLIER_MAX (=10) del DTO autoritativo de trip-service. Corta el dedazo ×100.
  multiplier: z.number().positive().max(10).optional(),
  minFareCents: z.number().int().nonnegative().max(100_000).optional(),
  // ADR 023 §3 · overrides de params por-oferta en céntimos PEN. Topes espejo de la tarifa base GLOBAL
  // (trip-service pricing.dto): banderazo S/200, S/50/km, S/20/min. `0` en per-km/per-min = no cobra
  // distancia/tiempo (Mecánico/Grúa). Ausente → el global. Dinero SIEMPRE Int, nunca float.
  baseFareCents: z.number().int().nonnegative().max(20_000).optional(),
  perKmCents: z.number().int().nonnegative().max(5_000).optional(),
  perMinCents: z.number().int().nonnegative().max(2_000).optional(),
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

/**
 * Body del POST /catalog/offerings (ADR 013) — ALTA de una oferta CUSTOM (acción de SUPERADMIN + step-up MFA).
 * El id lo GENERA trip-service (`custom_*`); `vehicleClass`/`serviceType` DEBEN ser tipos EXISTENTES (el dispatch
 * trabaja por vehicleClass — no se inventa un tipo de vehículo). Topes de cordura espejo del DTO autoritativo
 * (multiplier ≤ 10, minFare ≤ 100000 céntimos); el admin-bff + trip-service RE-validan. La respuesta es la oferta
 * ya resuelta (`catalogOffering`).
 */
export const createOfferingRequest = z.object({
  name: z.string().min(2).max(40),
  vehicleClass: z.enum(['CAR', 'MOTO']),
  serviceType: z.enum(['RIDE', 'AMBULANCE', 'TOW', 'MECHANIC']),
  mode: pricingMode,
  multiplier: z.number().positive().max(10),
  minFareCents: z.number().int().nonnegative().max(100_000),
  enabled: z.boolean().optional(),
});
export type CreateOfferingRequest = z.infer<typeof createOfferingRequest>;

/**
 * Métricas 30d de UNA oferta (GET /catalog/:id/metrics) — página-detalle del catálogo admin (board HjDvx
 * "Ofertas · Detalle"). Datos PROPIOS de trip-service por `Trip.category`. HONESTIDAD DE DATOS: `grossFareCents`
 * es facturación BRUTA (Σ Trip.fareCents), NO el revenue NETO de la plataforma (payment-service no denormaliza
 * la oferta → sin fuente limpia); el rating por oferta tampoco tiene fuente. Por eso el contrato expone SOLO
 * los dos hechos con fuente real (viajes + bruto); la UI omite honestamente lo que no está.
 */
export const offeringMetricsView = z.object({
  offeringId: z.string(),
  /** Tamaño de la ventana en días (30). */
  windowDays: z.number().int().positive(),
  /** Viajes COMPLETADOS de la oferta en la ventana (Trip.category = offeringId). */
  tripCount: z.number().int().nonnegative(),
  /** Facturación BRUTA (Σ Trip.fareCents, céntimos PEN). NO es el neto de la plataforma. */
  grossFareCents: z.number().int().nonnegative(),
});
export type OfferingMetricsView = z.infer<typeof offeringMetricsView>;

/* ── Dispatch: config de RADIOS (k-rings) + VENTANAS singleton global ── */

/**
 * Config de dispatch vigente (GET /admin/dispatch/radius-config): k-rings + ventanas + versión + sello.
 * `offerTimeoutMs` = ventana de la oferta directa FIXED (ms); `bidWindowSec` = ventana del board de PUJA (s).
 */
/**
 * Política v2 del modo FIXED (radio geométrico + expansión por anillos): el dispatch arranca en
 * `initialRadiusKm`, expande de a `incrementKm` cada `expandIntervalSec` hasta `maxRadiusKm` buscando
 * `targetDrivers`; cada oferta directa dura `offerTimeoutSec`. Radios/incrementos en KM (float), ventanas en s.
 */
export const fixedPolicy = z.object({
  initialRadiusKm: z.number(),
  incrementKm: z.number(),
  maxRadiusKm: z.number(),
  targetDrivers: z.number().int(),
  offerTimeoutSec: z.number().int(),
  expandIntervalSec: z.number().int(),
});
export type FixedPolicy = z.infer<typeof fixedPolicy>;

/** Política v2 del modo PUJA (broadcast a un radio único + ventana de board). */
export const pujaPolicy = z.object({
  broadcastRadiusKm: z.number(),
  bidWindowSec: z.number().int(),
});
export type PujaPolicy = z.infer<typeof pujaPolicy>;

/** Bloque de política v2 por modo (FIXED radio-geométrico + PUJA broadcast). `null` cuando `policyVersion==='v1'`. */
export const dispatchPolicyV2 = z.object({
  FIXED: fixedPolicy,
  PUJA: pujaPolicy,
});
export type DispatchPolicyV2 = z.infer<typeof dispatchPolicyV2>;

export const dispatchRadiusConfigView = z.object({
  nearbyKRing: z.number().int().min(1).max(8),
  matchKRing: z.number().int().min(1).max(8),
  offerTimeoutMs: z.number().int().min(5_000).max(120_000),
  bidWindowSec: z.number().int().min(15).max(300),
  /** `v1` = solo k-rings (legacy); `v2` = política geométrica por modo (FIXED/PUJA) en `policyV2`. */
  policyVersion: z.enum(['v1', 'v2']),
  /** Política geométrica por modo. `null` en `v1`. */
  policyV2: dispatchPolicyV2.nullable(),
  version: z.number().int(),
  updatedAt: z.string(),
});
export type DispatchRadiusConfigView = z.infer<typeof dispatchRadiusConfigView>;

/**
 * Body del PUT /admin/dispatch/radius-config: REEMPLAZA k-rings + ventanas (bump version aguas abajo).
 * `policyVersion`/`policyV2` son OPCIONALES (back-compat): un panel v1 sigue mandando solo k-rings + ventanas.
 */
export const replaceRadiusConfigRequest = z.object({
  nearbyKRing: z.number().int().min(1).max(8),
  matchKRing: z.number().int().min(1).max(8),
  offerTimeoutMs: z.number().int().min(5_000).max(120_000),
  bidWindowSec: z.number().int().min(15).max(300),
  policyVersion: z.enum(['v1', 'v2']).optional(),
  policyV2: dispatchPolicyV2.optional(),
});
export type ReplaceRadiusConfigRequest = z.infer<typeof replaceRadiusConfigRequest>;

/* ── Carpooling: config del radio de BÚSQUEDA (booking-service, singleton global) ──
 * El carpooling matchea por radio geométrico simple: `baseRadiusKm` es el radio inicial de búsqueda y
 * `expandRadiusKm` el radio ampliado si el base no cubre. Vive en booking-service (no en dispatch). */
export const carpoolSearchConfigView = z.object({
  baseRadiusKm: z.number(),
  expandRadiusKm: z.number(),
  version: z.number().int(),
  updatedAt: z.string(),
});
export type CarpoolSearchConfigView = z.infer<typeof carpoolSearchConfigView>;

/** Body del PUT /admin/dispatch/carpool-radius-config: REEMPLAZA los radios de búsqueda (bump version abajo). */
export const replaceCarpoolSearchConfigRequest = z.object({
  baseRadiusKm: z.number(),
  expandRadiusKm: z.number(),
});
export type ReplaceCarpoolSearchConfigRequest = z.infer<typeof replaceCarpoolSearchConfigRequest>;

/* ── Carpooling: MONITOREO de carpools ACTIVOS (booking-service · GET /finance/carpooling/active) ──
 * El panel de monitoreo lista las ofertas de carpooling VIVAS + KPIs agregados. TODO es dato REAL de
 * booking-service: ocupación = reservados/totales; conteos por estado; cupos libres. NO hay revenue acá — la
 * plata (fee recaudado) vive en payment/analytics, no en booking; este panel monitorea la OPERACIÓN, no el dinero. */

/** Estados ACTIVOS de una oferta en el monitoreo (viva: publicada/reservable, llena, o en curso). */
export const activeCarpoolState = z.enum([
  'PUBLICADO',
  'PARCIALMENTE_RESERVADO',
  'LLENO',
  'EN_RUTA',
]);
export type ActiveCarpoolState = z.infer<typeof activeCarpoolState>;

/** Un carpool activo del listado: ruta (coords públicas origen→destino), ocupación, salida, estado + conductor.
 *  `driverName` es best-effort (identity batch): `null` si identity no lo resolvió (degradación honesta). */
export const activeCarpoolItem = z.object({
  id: z.string(),
  origenLat: z.number(),
  origenLon: z.number(),
  destinoLat: z.number(),
  destinoLon: z.number(),
  fechaHoraSalida: z.string(),
  asientosTotales: z.number().int(),
  /** Reservados = asientosTotales − asientosDisponibles (server-truth, no inventado). */
  asientosReservados: z.number().int(),
  estado: activeCarpoolState,
  driverName: z.string().nullable(),
});
export type ActiveCarpoolItem = z.infer<typeof activeCarpoolItem>;

/** KPIs agregados del monitoreo — todos derivados de datos reales de booking-service (cero inventados). */
export const activeCarpoolStats = z.object({
  /** Ofertas activas (total real, no la página capada). */
  activeCount: z.number().int(),
  /** Ofertas actualmente EN_RUTA (en curso). */
  enRouteCount: z.number().int(),
  /** Σ asientos reservados en las ofertas activas. */
  seatsReserved: z.number().int(),
  /** Σ cupos libres en las ofertas activas. */
  seatsAvailable: z.number().int(),
  /** Ocupación promedio ponderada por asientos (reservados/totales · 100, entero). 0 si no hay asientos. */
  avgOccupancyPct: z.number().int(),
});
export type ActiveCarpoolStats = z.infer<typeof activeCarpoolStats>;

/** Respuesta del monitoreo: KPIs agregados + el listado (capado) de ofertas activas. */
export const activeCarpoolsView = z.object({
  stats: activeCarpoolStats,
  carpools: z.array(activeCarpoolItem),
});
export type ActiveCarpoolsView = z.infer<typeof activeCarpoolsView>;

/* ── Carpooling: DETALLE de un carpool + su CANCELACIÓN (booking-service · GET/POST /finance/carpooling/:id[/cancel]) ──
 * El detalle del panel finance/carpooling (frame m93bTI): recorrido (coords públicas — booking NO guarda nombres de
 * distrito), asientos + pasajeros, reparto de costo COST-SHARE derivable (por asiento / reparten / total), conductor +
 * vehículo. El FEE VEO y el "ahorro compartido" NO tienen fuente en estos seams (viven en payment/analytics) → se
 * OMITEN, nunca se inventan. La cancelación es la acción DESTRUCTIVA (transición → CANCELADO; libera cupos + avisa a los
 * pasajeros vía booking.cancelled). */

/** Un meeting point del recorrido: coords públicas + orden (booking guarda lat/lon, no el nombre del lugar). */
export const adminCarpoolStop = z.object({
  lat: z.number(),
  lon: z.number(),
  orden: z.number().int(),
});
export type AdminCarpoolStop = z.infer<typeof adminCarpoolStop>;

/** Un pasajero (reserva viva) del detalle: su tramo (pickup→dropoff coords) + precio acordado + estado.
 *  `passengerName` lo resuelve el admin-bff gateado por Ley 29733 (FINANCE puro no ve PII → null). */
export const adminCarpoolPassenger = z.object({
  bookingId: z.string(),
  passengerId: z.string(),
  passengerName: z.string().nullable(),
  asientos: z.number().int(),
  precioAcordadoCents: z.number().int(),
  estado: z.string(),
  pickupLat: z.number(),
  pickupLon: z.number(),
  dropoffLat: z.number(),
  dropoffLon: z.number(),
});
export type AdminCarpoolPassenger = z.infer<typeof adminCarpoolPassenger>;

/** Conductor público del detalle (nombre + rating). NULLABLE: identity caída / no resuelto (degradación honesta). */
export const adminCarpoolDriver = z.object({
  id: z.string(),
  name: z.string().nullable(),
  averageRating: z.number().nullable(),
});
export type AdminCarpoolDriver = z.infer<typeof adminCarpoolDriver>;

/** Vehículo público del detalle (modelo/placa/color). El objeto ES nullable: fleet caída / no encontrado → null. */
export const adminCarpoolVehicle = z.object({
  make: z.string(),
  model: z.string(),
  color: z.string(),
  plate: z.string(),
});
export type AdminCarpoolVehicle = z.infer<typeof adminCarpoolVehicle>;

/** DETALLE de un carpool (frame m93bTI). Recorrido (coords) + asientos/pasajeros + reparto de costo derivable +
 *  conductor + vehículo. TODO dato REAL de booking-service; el fee/payout y el ahorro se OMITEN (sin fuente). */
export const adminCarpoolDetailView = z.object({
  id: z.string(),
  estado: publishedTripState,
  fechaHoraSalida: z.string(),
  modoReserva: carpoolModoReserva,
  // (publishedTripState / carpoolModoReserva se importan de ./mobile.js — fuente única del enum del PublishedTrip)
  pais: z.string(),
  moneda: z.string(),
  origenLat: z.number(),
  origenLon: z.number(),
  originH3: z.string().nullable(),
  destinoLat: z.number(),
  destinoLon: z.number(),
  destH3: z.string().nullable(),
  stopovers: z.array(adminCarpoolStop),
  asientosTotales: z.number().int(),
  asientosDisponibles: z.number().int(),
  /** Reservados = totales − disponibles (server-truth del seat-lock). */
  asientosReservados: z.number().int(),
  /** Precio del asiento (céntimos PEN, cost-share por asiento). */
  precioBaseCents: z.number().int(),
  /** Asientos que reparten el costo = reservados (cupos ya tomados). */
  asientosQueReparten: z.number().int(),
  /** Tarifa total del trayecto = precioBaseCents × reservados (céntimos PEN). */
  tarifaTotalCents: z.number().int(),
  driver: adminCarpoolDriver,
  vehicle: adminCarpoolVehicle.nullable(),
  pasajeros: z.array(adminCarpoolPassenger),
});
export type AdminCarpoolDetailView = z.infer<typeof adminCarpoolDetailView>;

/** Resultado de CANCELAR un carpool: el id + su estado nuevo (CANCELADO) + el estado previo. */
export const cancelCarpoolResult = z.object({
  id: z.string(),
  estado: publishedTripState,
  estadoAnterior: publishedTripState,
});
export type CancelCarpoolResult = z.infer<typeof cancelCarpoolResult>;

/* ── Radar preview: anillos de cobertura para un punto (visualización de la config vigente) ──
 * Cada anillo lleva su radio (km), su k-ring y el conteo de conductores dentro. El admin-bff NORMALIZA el
 * conteo a `count` sea cual sea el servicio de origen (dispatch usa `driverCount`, booking usa `count`). */
export const radarRing = z.object({
  radiusKm: z.number(),
  kRing: z.number().int(),
  count: z.number().int(),
});
export type RadarRing = z.infer<typeof radarRing>;

/**
 * Una POSICIÓN real de un conductor/oferta para plotear en el mapa del radar (lat/lon). MUESTRA acotada
 * (no el set completo): dispatch la deriva del anillo más ancho del hot-index (posiciones de conductores
 * disponibles); booking la deriva de los ORÍGENES de las ofertas de carpooling en rango. Sin PII (solo el
 * punto). `[]` honesto si el servicio no puede materializar posiciones (nunca se inventan coordenadas).
 */
export const radarDriverPosition = z.object({ lat: z.number(), lon: z.number() });
export type RadarDriverPosition = z.infer<typeof radarDriverPosition>;

/** Preview del radar: centro + anillos de cobertura + total en rango + muestra de posiciones. `mode` presente solo en el radar de dispatch. */
export const radarPreview = z.object({
  mode: z.string().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }),
  rings: z.array(radarRing),
  totalInRange: z.number().int(),
  /** MUESTRA (capada a 100) de posiciones reales para plotear marcadores en el mapa. Ausente/`[]` si el servicio no las provee. */
  drivers: z.array(radarDriverPosition).optional(),
});
export type RadarPreview = z.infer<typeof radarPreview>;

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
  /** Placa del vehículo (enriquecida on-read desde fleet · GetVehiclesByIds), para NO mostrar `veh_<id>` crudo
   *  en la tabla de Inspecciones. null si el vehículo ya no existe (degradación honesta → cae al id). */
  plate: z.string().nullable(),
  status: z.string(),
  inspectedAt: z.string().nullable(),
  scheduledAt: z.string().nullable(),
  /** Nombre del inspector (enriquecido on-read desde identity · GetUsersByIds · PII gateada a Compliance+). null
   *  para sub-Compliance, o si el inspector no es un usuario resoluble (p.ej. registro sintético). */
  inspector: z.string().nullable(),
  result: z.string().nullable(),
  // Centro (CITV) donde se realizó la inspección. Nullable: las auto-registradas al aprobar el doc ITV no lo traen.
  center: z.string().nullable(),
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
  center: z.string().optional(),
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
  /** Email del solicitante (STAFF · accountability de la doble-auth). Lo provee media-service; siempre presente. */
  requesterEmail: z.string(),
  /** Nombre del solicitante (enriquecido on-read desde el roster de operadores identity); null si no se resolvió. */
  requesterName: z.string().nullable(),
  /** Rol admin CRUDO del solicitante (AdminRole · el front lo traduce a etiqueta); null si no se resolvió. */
  requesterRole: z.string().nullable(),
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

/* ── Muro de cámaras en vivo (/security/live-cabins) ── */
/**
 * Cabina de un viaje EN CURSO para el muro de cámaras (frame "Cámaras en vivo" · T/CameraTile). Enriquecida
 * on-read por el admin-bff (fan-out gRPC + reverse-geocode soberano): NO abre el feed (eso exige doble-auth
 * por-viaje), solo describe el tile. `startedAt` alimenta el timer EN VIVO client-side (tiempo en curso).
 * PII/redacción por rol: `driverName` (Compliance+ → null sub-Compliance), `plate` (dispatch+ → enmascarada
 * SUPPORT), `district` (geo — solo roles con geo exacta). Degradación honesta: lo ausente → null, nunca inventa.
 */
export const liveCabin = z.object({
  tripId: z.string(),
  /** Nombre del conductor (PII · Compliance+ → null); null si aún sin asignar. */
  driverName: z.string().nullable(),
  /** Placa del vehículo operado (dispatch+ ve completa, SUPPORT enmascarada); null si no hay vehículo. */
  plate: z.string().nullable(),
  /** Distrito de origen del viaje (reverse-geocode soberano); null sin geo exacta / sin match / geocoder caído. */
  district: z.string().nullable(),
  /** Estado del viaje (siempre IN_PROGRESS en el muro, pero tipado por si el read-model trae otro). */
  status: adminTripStatus,
  /** ISO-8601 del inicio del viaje (requestedAt) → timer "tiempo en curso" en vivo del tile. */
  startedAt: z.string(),
});
export type LiveCabin = z.infer<typeof liveCabin>;

/* ── Auditoría: verificación de cadena hash ── */
export const auditChainVerification = z.object({
  valid: z.boolean(),
  checkedEntries: z.number().int(),
  brokenAtSeq: z.string().nullable(),
  verifiedAt: z.string(),
});
export type AuditChainVerification = z.infer<typeof auditChainVerification>;
