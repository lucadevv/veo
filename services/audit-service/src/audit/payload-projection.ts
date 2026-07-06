/**
 * PROYECCIÓN ALLOWLIST del payload de auditoría (fix de soberanía · FOUNDATION §0.7 · Ley 29733).
 *
 * EL PROBLEMA: el WORM persiste el payload del evento de dominio CRUDO (audit.repository → `payload`),
 * con object-lock e IRREVERSIBLE. Si un evento porta PII (teléfono, email, geo, body de chat, nombre),
 * esa PII queda FIJADA para siempre en un log inmutable → choca con el derecho al olvido.
 *
 * LA SOLUCIÓN (este módulo): antes de persistir, el payload se PROYECTA contra una ALLOWLIST tipada por
 * eventType. Solo los campos EXPLÍCITAMENTE seguros (IDs, montos en céntimos, enums de estado, timestamps)
 * sobreviven. Todo lo demás se descarta. La esencia forense (quién/qué/cuál/cuándo) ya vive en las columnas
 * actorId/action/resourceType/resourceId/occurredAt de la fila — el payload es solo DETALLE complementario.
 *
 * DOS GARANTÍAS, en capas:
 *  1) ALLOWLIST (positiva): un eventType SIN allowlist → `{}` vacío (SAFE-BY-DEFAULT). NUNCA denylist: un
 *     campo PII nuevo que aparezca en un evento jamás se filtra porque NADA pasa salvo lo explícitamente listado.
 *  2) DENYLIST defensiva (negativa, defensa en profundidad): aunque un campo esté en la allowlist, si su NOMBRE
 *     matchea un patrón PII conocido se descarta igual. Atrapa un error humano (alguien allowlistó `phone` sin querer).
 *
 * El resultado es SIEMPRE un objeto plano de primitivas/arrays-de-primitivas seguras: arrays/objetos anidados
 * se descartan salvo que sean un array de strings/números (ej. `roles`, `contactIds`) explícitamente allowlisted.
 */
import type { EventType } from '@veo/events';

/**
 * Tokens de nombre de campo que JAMÁS van al WORM (defensa en profundidad sobre la allowlist).
 * Se comparan por PALABRA COMPLETA contra los tokens del nombre del campo (ver `tokenizeFieldName`/`isPiiFieldName`):
 * `phoneMasked`→['phone','masked'] matchea `phone`; `originLat`→['origin','lat'] matchea `origin` y `lat`;
 * `platformCents`→['platform','cents'] NO matchea (la plata sobrevive). Cada entrada DEBE ser un token único
 * en minúsculas (NO una subcadena): `walletUid`→['wallet','uid'], por eso van `wallet`+`uid` separados.
 * Esta lista es la MISMA que asegura el test PII-guard (single source de la denylist conceptual).
 */
const PII_FIELD_PATTERNS: readonly string[] = [
  'phone',
  'email',
  'name', // firstName/lastName/fullName/displayName → ['first','name']…
  'body',
  'geo',
  'lat',
  'lon',
  'lng',
  'latitude',
  'longitude',
  'coordinate',
  'coordinates',
  'address',
  // `walletUid` → tokens ['wallet','uid']: lo mata el token `uid` (abajo). NO denylisteamos `wallet`
  // a secas porque es un enum SEGURO (YAPE/PLIN) allowlisted en afiliación — el PII es el uid, no el riel.
  'uid',
  'token',
  'dni',
  'point', // geoPoint → ['geo','point']
  'origin', // originLat/originLon → ['origin','lat']…  (NO 'origen': es el enum de aprobación de booking, no geo;
  //         los `origenLat/origenLon` geográficos de booking.updated igual caen por el token 'lat'/'lon')
  'destination',
  'destino',
  'watermark', // lleva el email/identidad del operador embebido
  'to', // destinatario crudo de notification (token push / número / email)
  'recipient',
  'contact',
  'contactids', // por si llega sin tokenizar limpio

  // ── TEXTO LIBRE (defensa en profundidad · ALTA reason free-text): nombres de campos que suelen ser
  // `z.string` libre tipeado por un usuario/operador → pueden traer PII (nombre/teléfono/"llamó al +51..").
  // Si un futuro allowlist los incluye por error, igual se dropean. NO incluye 'reason': `reason` se cura por
  // allowlist (solo se allowlistea donde el schema lo tipa como z.enum), NO por denylist — denylistearlo
  // rompería los reason-enum SEGUROS (driver.flagged, dispatch.*). Tampoco 'message' (rompería `messageId`).
  // ('body' ya está arriba en el grupo de contenido.)
  'note',
  'comment',
  'description',
  'subject',
  'text',
  'remarks',
  'freetext',
  'plate', // matrícula del vehículo (cuasi-identificador, z.string libre)
] as const;

/**
 * Tokeniza un nombre de campo en PALABRAS, soportando camelCase, PascalCase, snake_case y kebab-case.
 * `platformCents` → ['platform','cents']; `originLat` → ['origin','lat']; `phone_number` → ['phone','number'].
 * Las palabras se devuelven en minúsculas para comparar contra la denylist sin importar el casing.
 */
function tokenizeFieldName(field: string): string[] {
  return field
    // inserta un separador en los bordes camelCase/PascalCase: aB → a B, y XMLHttp → XML Http
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * ¿El nombre de un campo matchea algún patrón PII? Por PALABRA COMPLETA (token), NO por subcadena — así
 * `platformCents`/`commissionCents` NO son falsos positivos de `lat`/... y la plata sobrevive, mientras
 * `lat`/`phoneNumber`/`geoPoint` SÍ se detectan (['lat'] / ['phone','number'] / ['geo','point']).
 * CAUSA RAÍZ del bug anterior: el `includes` por subcadena destruía campos seguros (`'lat' ⊂ 'platformCents'`).
 */
export function isPiiFieldName(field: string): boolean {
  const tokens = new Set(tokenizeFieldName(field));
  return PII_FIELD_PATTERNS.some((p) => tokens.has(p));
}

/**
 * ¿Un valor es una primitiva segura para el WORM? (string/number/boolean) o un array de primitivas seguras.
 * Objetos anidados y arrays de objetos se RECHAZAN: pueden esconder PII en una hoja que la allowlist plana no ve.
 */
function isSafeScalar(value: unknown): boolean {
  return (
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
  );
}
function isSafeValue(value: unknown): boolean {
  if (isSafeScalar(value)) return true;
  if (Array.isArray(value)) return value.every(isSafeScalar);
  return false;
}

/**
 * ACCIONES SÍNCRONAS de admin (carril `recordSync` · POST /audit + gRPC Record): NO son eventos de dominio
 * de EVENT_SCHEMAS, los origina un operador desde admin-bff (ops/finance/media). Sus `action` son la KEY de
 * proyección. Se tipan aparte para poder allowlistear sus campos forenses SEGUROS — JAMÁS email/reason free-text.
 */
type SyncAuditAction =
  | 'operator.create'
  | 'payment.refund'
  | 'media.access_request'
  | 'media.access_approve'
  | 'media.access_reject'
  | 'media.access_stream';

/** Key de proyección: un eventType de dominio O una acción síncrona de admin. */
type AuditProjectionKey = EventType | SyncAuditAction;

/**
 * ALLOWLIST tipada: para cada key (eventType de dominio o acción síncrona), los campos del payload que tienen
 * VALOR FORENSE y son seguros. Lo NO listado se descarta. Una key ausente del mapa proyecta a `{}`
 * (mapping-only, safe-by-default).
 *
 * Criterio de inclusión: IDs (correlación), montos en céntimos (plata), enums de estado/razón (decisión),
 * timestamps, contadores, period/version. Se EXCLUYE deliberadamente todo lo geográfico, de contacto y de
 * contenido libre — eso lo refuerza además la denylist defensiva de arriba.
 */
const AUDIT_PAYLOAD_ALLOWLIST: Partial<Record<AuditProjectionKey, readonly string[]>> = {
  // ── identidad / KYC ── (kycStatus es z.string LIBRE → FUERA; reason de rejection es z.string LIBRE → FUERA)
  'user.registered': ['userId'],
  'user.kyc_verified': ['userId', 'verifiedAt'],
  'user.email_verified': ['userId', 'verifiedAt'], // email NO (PII)
  'user.deletion_requested': ['userId', 'requestedAt', 'graceUntil'],
  'user.deleted': ['userId', 'driverId', 'at'],
  'admin.role_changed': ['adminUserId', 'roles', 'changedBy', 'at'],
  'driver.registered': ['driverId', 'userId', 'registeredAt'],
  'driver.verified': ['driverId', 'userId', 'verifiedAt'],
  'driver.rejected': ['driverId', 'userId', 'rejectedAt'], // reason z.string LIBRE → FUERA
  'driver.suspended': ['driverId', 'suspendedAt'], // reason z.string LIBRE → FUERA
  'driver.resubmitted': ['driverId', 'userId', 'resubmittedAt'],
  'driver.reactivated': ['driverId', 'reactivatedAt'],
  'driver.excessive_cancellations': ['driverId', 'count', 'windowStart', 'occurredAt'],
  'biometric.failed': ['driverId', 'score', 'attempt', 'at'],
  'biometric.enrolled': ['driverId', 'userId', 'livenessChecked', 'score', 'at'],
  'biometric.enroll_rejected': ['driverId', 'userId', 'score', 'at'], // reason z.string LIBRE → FUERA
  // ── referidos / recompensas ──
  'user.referred': ['referrerUserId', 'referredUserId', 'at'], // code NO (cupón, no forense de PII pero innecesario)
  'referral.rewarded': ['referrerUserId', 'referredUserId', 'rewardCents', 'tripId', 'at'],
  'promo.redeemed': ['promotionId', 'userId', 'tripId', 'discountCents', 'at'],
  'incentive.completed': ['incentiveId', 'driverId', 'rewardCents', 'tripsCompleted', 'at'],
  // ── viaje (ciclo) — geo/origin/destination/point se descartan ──
  // `category` es z.string LIBRE (schema) → fuera del allowlist (ningún texto libre); `vehicleType` (enum) cubre la clase.
  'trip.requested': ['tripId', 'passengerId', 'fareCents', 'childMode', 'vehicleType', 'scheduled'],
  'trip.assigned': ['tripId', 'driverId', 'vehicleId'],
  'trip.accepted': ['tripId', 'driverId', 'etaSeconds', 'passengerId'],
  'trip.arriving': ['tripId', 'driverId', 'etaSeconds', 'at', 'passengerId'],
  'trip.arrived': ['tripId', 'driverId', 'at', 'passengerId', 'waitWindowSeconds'],
  'trip.started': ['tripId', 'driverId', 'startedAt', 'passengerId'],
  'trip.completed': [
    'tripId',
    'fareCents',
    'distanceMeters',
    'durationSeconds',
    'driverId',
    'passengerId',
    'paymentMethod',
    'cashCollected',
  ],
  // `by` es z.enum (PASSENGER/DRIVER/SYSTEM) → SEGURO; `reason` es z.string().optional() LIBRE → FUERA
  'trip.cancelled': ['tripId', 'by', 'penaltyCents', 'driverId', 'passengerId'],
  'trip.child_code_failed': ['tripId', 'driverId', 'passengerId', 'attempt', 'at'],
  // `fromStatus` es z.string LIBRE → FUERA (el estado del watchdog se infiere de la action/recurso)
  'trip.expired': ['tripId', 'passengerId', 'driverId', 'staleMinutes', 'at'],
  'trip.failed': ['tripId', 'passengerId', 'driverId', 'staleMinutes', 'at'],
  'trip.pii_erased': ['tripId', 'passengerId', 'at'],
  'trip.bid_posted': ['tripId', 'passengerId', 'bidCents', 'vehicleType', 'windowSec', 'negotiationSeq', 'scheduled'],
  // `reason` acá es z.enum(['driver_cancelled']) → SEGURO, se queda
  'trip.reassigning': ['tripId', 'driverId', 'passengerId', 'vehicleType', 'bidCents', 'reason', 'negotiationSeq'],
  'trip.waypoint_proposed': ['proposalId', 'tripId', 'passengerId', 'driverId', 'deltaFareCents', 'newFareCents', 'expiresAt'],
  'trip.waypoint_accepted': ['proposalId', 'tripId', 'passengerId', 'driverId', 'deltaFareCents', 'newFareCents'],
  'trip.waypoint_rejected': ['proposalId', 'tripId', 'passengerId', 'driverId'],
  'trip.waypoint_expired': ['proposalId', 'tripId', 'passengerId'],
  // ── dispatch — originLat/originLon se descartan ──
  'dispatch.match_found': ['tripId', 'driverId', 'vehicleId', 'scoreMs'],
  'dispatch.offered': ['tripId', 'driverId', 'matchId', 'expiresAt', 'bidCents', 'vehicleType'],
  'dispatch.offer_made': ['tripId', 'driverId', 'kind', 'priceCents', 'etaSeconds'],
  'dispatch.offer_accepted': ['tripId', 'driverId', 'priceCents', 'negotiationSeq'],
  // `reason` acá es z.enum/z.literal (window_expired/all_lapsed/no_candidates · cancelled_by_passenger · stale/taken) → SEGURO
  'dispatch.no_offers': ['tripId', 'reason'],
  'dispatch.bid_cancelled': ['tripId', 'reason'],
  'dispatch.offer_withdrawn': ['tripId', 'driverId', 'reason'],
  // ── pricing (config snapshot; rules es array de objetos → se descarta, queda version) ──
  'pricing.mode_schedule_updated': ['defaultMode', 'version', 'updatedAt'],
  'pricing.bid_floor_updated': ['defaultFloorCents', 'version', 'updatedAt'],
  // base_fare/commission: montos en céntimos y tasas bps son SEGUROS (Int; la denylist tokeniza y no matchea).
  'pricing.base_fare_updated': ['baseFareCents', 'perKmCents', 'perMinCents', 'version', 'updatedAt'],
  'payment.commission_updated': ['onDemandRateBps', 'carpoolingFeeBps', 'version', 'updatedAt'],
  // ── media — segmentId/tripId/operatorId sí; watermark NO (lleva identidad); operatorEmail NO ──
  'media.recording_started': ['tripId', 'startedAt'],
  'media.archived': ['tripId', 's3Key', 'bytes', 'retentionDays'],
  'media.access_granted': ['requestId', 'tripId', 'segmentId', 'operatorId', 'approvedBy', 'expiresAt', 'at'],
  'media.access_rejected': ['requestId', 'tripId', 'segmentId', 'operatorId', 'rejectedBy', 'at'],
  'media.access_viewed': ['requestId', 'tripId', 'segmentId', 'operatorId', 'viewedBy', 'expiresAt', 'at'],
  // render (burn-in Lote 3): IDs técnicos + timestamp. `reason` de failed es una CATEGORÍA técnica (enum
  // SOURCE_NOT_FOUND/STORAGE_OR_RENDER_FAILED/INVALID_INPUT/UNKNOWN de categorizeRenderError), NO texto libre
  // ni PII → seguro. completed no porta reason (terminó OK).
  'media.render_completed': ['requestId', 'tripId', 'segmentId', 'at'],
  'media.render_failed': ['requestId', 'tripId', 'reason', 'at'],
  // ── pagos / payouts ── (`method` es z.enum → SEGURO; `reason` de failed/refunded es z.string LIBRE → FUERA;
  // `period` de payout es z.string LIBRE → FUERA)
  'payment.captured': ['paymentId', 'tripId', 'method', 'grossCents', 'commissionCents', 'passengerId'],
  'payment.failed': ['paymentId', 'tripId', 'willRetry'], // reason z.string LIBRE → FUERA
  'payment.tip_added': ['paymentId', 'tripId', 'driverId', 'tipCents'],
  'payment.cash_pending': ['paymentId', 'tripId', 'grossCents', 'passengerId'],
  'payment.refunded': ['paymentId', 'tripId', 'amountCents', 'approvedBy', 'passengerId'], // reason z.string LIBRE → FUERA
  'payment.cancellation_penalty_recorded': [
    'penaltyId',
    'tripId',
    'passengerId',
    'driverId',
    'penaltyCents',
    'driverCompensationCents',
    'platformCents',
  ],
  'payment.cancellation_penalty_collected': [
    'penaltyId',
    'tripId',
    'passengerId',
    'driverId',
    'penaltyCents',
    'driverCompensationCents',
    'platformCents',
    'settlementPaymentId',
  ],
  'payment.affiliation_activated': ['affiliationId', 'userId', 'wallet', 'at'], // phoneMasked NO
  'payment.affiliation_expired': ['affiliationId', 'userId', 'wallet', 'at'],
  'payout.processing': ['payoutId', 'driverId', 'amountCents'], // period z.string LIBRE → FUERA
  'payout.processed': ['payoutId', 'driverId', 'amountCents'],
  'payout.failed': ['payoutId', 'driverId', 'amountCents'],
  // ── pánico — geo se descarta (lo aporta la columna/forense vía resourceId); contactIds NO (PII de terceros) ──
  'panic.triggered': ['panicId', 'tripId', 'passengerId', 'triggeredAt'], // dedupKey z.string LIBRE → FUERA
  'panic.acknowledged': ['panicId', 'tripId', 'passengerId', 'operatorId', 'ackAt'],
  // `status` es z.enum (RESOLVED/FALSE_ALARM) → SEGURO
  'panic.resolved': ['panicId', 'tripId', 'passengerId', 'status', 'resolvedBy', 'at'],
  'panic.fanout_requested': ['panicId', 'tripId', 'passengerId'], // geo/contactIds/shareLink NO
  // ── notification — `to` y `error` técnico NO; `channel` SOLO donde es z.enum (sent/delivered); en failed es z.string LIBRE → FUERA ──
  'notification.sent': ['notificationId', 'channel'], // channel z.enum → SEGURO
  'notification.delivered': ['notificationId', 'channel'], // channel z.enum → SEGURO
  'notification.failed': ['notificationId'], // channel acá es z.string LIBRE + `error` free-text → ambos FUERA
  // ── rating ──
  'rating.created': ['ratingId', 'tripId', 'driverId', 'stars'],
  'driver.flagged': ['driverId', 'rollingAvg', 'reason'],
  'passenger.flagged': ['passengerId', 'rollingAvg', 'reason'],
  // ── share — shareLink/url NO ──
  'share.link_generated': ['shareId', 'tripId', 'expiresAt'],
  'share.viewed': ['shareId', 'at'],
  // ── chat — body NO; solo metadato de existencia/autoría ──
  'chat.message_sent': ['messageId', 'tripId', 'senderId', 'senderRole', 'createdAt'],
  // ── fleet ── (`ownerType`/`verdict` z.enum → SEGURO; `reason`/`documentType`/`make`/`model`/`plate` z.string LIBRE → FUERA)
  'fleet.document_expired': ['documentId', 'ownerType', 'ownerId', 'expiresAt', 'critical'], // documentType z.string LIBRE → FUERA
  'fleet.document_rejected': ['documentId', 'ownerType', 'ownerId', 'rejectedAt'], // documentType z.string LIBRE → FUERA; reason no viaja en el evento
  'fleet.driver_suspended': ['driverId', 'userId', 'documentId', 'vehicleId', 'inspectionId', 'suspendedAt'], // reason+documentType LIBRES → FUERA
  'fleet.driver_reactivated': ['driverId', 'userId', 'vehicleId', 'inspectionId', 'documentId', 'reactivatedAt'], // reason+documentType LIBRES → FUERA
  'fleet.vehicle_suspended': ['vehicleId', 'suspendedAt'], // reason z.string LIBRE → FUERA
  'fleet.vehicle_registered': ['vehicleId', 'driverId', 'vehicleType', 'registeredAt'], // plate z.string LIBRE (PII de matrícula) → FUERA
  'fleet.vehicle_model_reviewed': ['modelId', 'requestedBy', 'verdict', 'reviewedAt'], // make/model z.string LIBRES → FUERA
  // ── booking (carpooling) — geo se descarta; modoReserva/estado/origen/razon son z.enum/literal → SEGUROS;
  // pais/moneda/estadoAnterior son z.string LIBRES → FUERA ──
  'booking.published': ['publishedTripId', 'driverId', 'vehicleId', 'asientosTotales', 'precioBase', 'modoReserva', 'fechaHoraSalida'], // pais/moneda LIBRES → FUERA
  'booking.requested': ['bookingId', 'publishedTripId', 'passengerId', 'driverId', 'asientos', 'precioAcordado', 'modoReserva', 'estado'],
  'booking.approved': ['bookingId', 'publishedTripId', 'passengerId', 'driverId', 'asientos', 'precioAcordado', 'modoReserva', 'estado', 'origen'],
  'booking.updated': ['publishedTripId', 'driverId', 'vehicleId', 'asientosTotales', 'precioBase', 'modoReserva', 'fechaHoraSalida'],
  'booking.confirmed': ['bookingId', 'publishedTripId', 'passengerId', 'asientos', 'precioAcordado', 'paymentId', 'estado'],
  'booking.cancelled': ['publishedTripId', 'driverId', 'bookingId', 'razon', 'estado'], // estadoAnterior z.string LIBRE → FUERA

  // ── ACCIONES SÍNCRONAS de admin (carril recordSync) — JAMÁS email/reason free-text al WORM ──
  // operator.create: el caller manda {email, roles}. SOLO `roles` (enum de permisos, forense); email → drop.
  'operator.create': ['roles'],
  // payment.refund: {tripId, amountCents, reason}. tripId + amountCents (plata); `reason` free-text → drop.
  'payment.refund': ['tripId', 'amountCents'],
  // media.access_request: {tripId, reason}. tripId; `reason` free-text (puede traer PII del caso) → drop.
  'media.access_request': ['tripId'],
  // media.access_approve/reject: {tripId, status}. Ambos seguros (status = enum de la solicitud).
  'media.access_approve': ['tripId', 'status'],
  'media.access_reject': ['tripId', 'status'],
  // media.access_stream: {segmentId, expiresAt}. Ambos seguros (IDs/timestamps).
  'media.access_stream': ['segmentId', 'expiresAt'],
};

/**
 * Proyecta el payload de un evento al subconjunto SEGURO para el WORM.
 *
 * @returns objeto plano con SOLO los campos allowlisted que (a) existen, (b) son primitivas/arrays seguros y
 *   (c) NO matchean la denylist PII. Un eventType sin allowlist o un payload no-objeto → `{}` (mapping-only).
 */
export function projectAuditPayload(
  eventType: string,
  payload: unknown,
): Record<string, unknown> {
  const allowed = AUDIT_PAYLOAD_ALLOWLIST[eventType as AuditProjectionKey];
  if (!allowed || typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return {};
  }
  const source = payload as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const field of allowed) {
    // Defensa en profundidad: aunque esté en la allowlist, si el NOMBRE huele a PII, se descarta.
    if (isPiiFieldName(field)) continue;
    if (!(field in source)) continue;
    const value = source[field];
    if (value === undefined || value === null) continue;
    if (!isSafeValue(value)) continue; // descarta objetos/arrays-de-objetos anidados (posible PII en hojas)
    safe[field] = value;
  }
  return safe;
}

/** Expuesto para el test PII-guard: la denylist conceptual que NINGÚN payload persistido puede contener. */
export const PII_DENYLIST_PATTERNS = PII_FIELD_PATTERNS;
