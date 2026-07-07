/**
 * Mappers OPS: registros del read-model / replies gRPC → vistas públicas de @veo/api-client.
 */
import {
  normalizeTripStatus,
  type AdminTripStatus,
  type DriverApproval,
  type DriverSummary,
  type TripStatus,
  type TripSummary,
} from '@veo/api-client';
import type { AdminRole, SuspensionCause } from '@veo/shared-types';
import type { TripRecord, DriverRecord } from '../read-model/read-model.service';

/**
 * `fareCents` es `number` NO-nullable en el contrato (`tripSummary`/`tripDetail` de @veo/api-client).
 * La matriz aprobada manda redactar montos a `null` para roles sin permiso financiero, pero hacerlo
 * acá rompería el contrato (toca @veo/api-client + UI admin-web). Por eso la redacción de MONTOS en
 * /ops/trips queda DIFERIDA (identidad es la prioridad de este lote); ver reporte. `roles` se acepta
 * ya en la firma para no re-tocar call-sites cuando el contrato se haga nullable.
 */
export function tripRecordToSummary(r: TripRecord, _roles: readonly AdminRole[]): TripSummary {
  return {
    id: r.id,
    status: r.status,
    passengerId: r.passengerId,
    driverId: r.driverId,
    fareCents: r.fareCents,
    createdAt: r.createdAt,
  };
}

export function driverRecordToSummary(r: DriverRecord): DriverSummary {
  return {
    id: r.id,
    userId: r.userId,
    status: r.status,
    averageRating: r.averageRating,
    backgroundCheckStatus: r.backgroundCheckStatus,
  };
}

/** Estado de suspensión proyectado en el badge de la lista (reconciliado contra la autoridad de identity). */
const DRIVER_STATUS_SUSPENDED = 'SUSPENDED';
const DRIVER_STATUS_ACTIVE = 'ACTIVE';

/**
 * Enriquecimiento por-conductor que el admin-bff resuelve on-read contra identity (lectura batch, sin N+1):
 *  - `fullName`/`phone`: PII (Compliance+); null para sub-Compliance o sin dato.
 *  - `suspendedAt`: estado AUTORITATIVO de suspensión derivado de los holds ("" → null acá ⇒ libre; ISO ⇒
 *    suspendido). NO es PII: se usa para reconciliar el badge de la lista para TODOS los roles.
 *  - `suspensionCauses`: las `cause` DISTINTAS de los holds vigentes (DISCIPLINARY/DOCUMENT_EXPIRED/
 *    INSPECTION_EXPIRED · modelo de HOLDS, derivado en identity). El panel las usa para ofrecer la acción de
 *    reactivación correcta por fila (cause-aware), igual que el detalle. NO es PII (es un enum de motivo);
 *    se proyecta para TODOS los roles. [] cuando el conductor no tiene holds.
 */
export interface DriverListEnrichment {
  fullName: string | null;
  phone: string | null;
  suspendedAt: string | null;
  suspensionCauses: SuspensionCause[];
  /** Completitud documental (docs REQUERIDOS en VALID / total · fleet batch). No es PII → para todos los roles. */
  docsComplete: number;
  docsTotal: number;
  /** Estado combinado de verificación biométrica (VERIFICADO/REVISAR/PENDIENTE); null si sub-Compliance (redactado). */
  verificationStatus: string | null;
}

/**
 * Registro del read-model → vista de APROBACIÓN del contrato. `submittedAt` se aproxima con `updatedAt`
 * (última señal del registro). El contrato exige las claves presentes (nullable).
 *
 * RECONCILIACIÓN DEL BADGE DE SUSPENSIÓN (autoridad: identity · modelo de HOLDS): el `status` del read-model
 * es event-driven y queda STALE en dos casos que reconciliamos contra el `suspendedAt` autoritativo de identity
 * (cuando vino en el enriquecimiento, que es siempre que la página no es vacía):
 *   - identity dice SUSPENDIDO (`suspendedAt != null`) pero el read-model NO lo refleja → forzamos SUSPENDED.
 *     Cubre la suspensión por ITV (llega keyeada por User.id; el consumer del read-model no la proyecta).
 *   - identity dice LIBRE (`suspendedAt == null`) pero el read-model dice SUSPENDED → forzamos ACTIVE. Cubre la
 *     AUTO-reactivación (el conductor regularizó un documento/ITV; identity quitó el hold SIN emitir
 *     `driver.reactivated` — ese evento solo lo emite la reactivación del OPERADOR).
 * Solo se reconcilia el eje SUSPENDED↔ACTIVE: PENDING/REJECTED (antecedentes) NO se tocan — un conductor
 * PENDIENTE con `suspendedAt` null NO debe volverse ACTIVE por esta vía. Sin enriquecimiento (no debería pasar
 * con página no vacía) → se conserva el status del read-model (degradación honesta, nunca se inventa).
 */
export function driverRecordToApproval(
  r: DriverRecord,
  // La redacción de PII (fullName/phone) ya se aplicó al construir el `enrichment` (en ops.service.listDrivers,
  // donde vive el rol); acá solo se proyecta. `_roles` se mantiene en la firma para no re-tocar el call-site.
  _roles: readonly AdminRole[],
  enrichment?: DriverListEnrichment,
): DriverApproval {
  // IDENTIDAD (fullName/phone) = Compliance+ (el enrichment ya viene redactado a null para sub-Compliance).
  // Los eventos driver.* NO llevan PII (Ley 29733) → la identidad se resuelve on-read contra identity.
  const summary = driverRecordToSummary(r);
  return {
    ...summary,
    status: reconcileSuspensionBadge(summary.status, enrichment),
    fullName: enrichment?.fullName ?? null,
    phone: enrichment?.phone ?? null,
    submittedAt: r.updatedAt,
    // Motivo del último rechazo (proyectado del evento driver.rejected); null si no está rechazado.
    rejectionReason: r.rejectionReason,
    // CAUSAS de suspensión (autoridad: identity · modelo de HOLDS) para la UI cause-aware de reactivación.
    // Sin enriquecimiento (página vacía no debería darse) → [] honesto, nunca se inventa.
    suspensionCauses: enrichment?.suspensionCauses ?? [],
    // Completitud documental (fleet batch) + verificación (identity batch). Sin enriquecimiento → 0/0 y null
    // (degradación honesta, nunca se inventa). verificationStatus ya viene redactado a null para sub-Compliance.
    docsComplete: enrichment?.docsComplete ?? 0,
    docsTotal: enrichment?.docsTotal ?? 0,
    verificationStatus: enrichment?.verificationStatus ?? null,
  };
}

/**
 * Reconcilia el eje SUSPENDED↔ACTIVE del badge contra el estado autoritativo de identity. Sin enriquecimiento
 * (`suspendedAt` indefinido) → se conserva el status del read-model. Solo cruza entre SUSPENDED y ACTIVE: los
 * demás estados (PENDING/REJECTED) se conservan tal cual (no son sobre suspensión).
 */
function reconcileSuspensionBadge(
  readModelStatus: string,
  enrichment?: DriverListEnrichment,
): string {
  if (!enrichment) return readModelStatus;
  const suspendedByIdentity = enrichment.suspendedAt !== null;
  if (suspendedByIdentity) return DRIVER_STATUS_SUSPENDED;
  // identity dice LIBRE: solo bajamos de SUSPENDED a ACTIVE (no tocamos PENDING/REJECTED).
  if (readModelStatus === DRIVER_STATUS_SUSPENDED) return DRIVER_STATUS_ACTIVE;
  return readModelStatus;
}

/**
 * Vista OPS de cada estado del contrato — EXHAUSTIVO: agregar un `TripStatus` nuevo sin decidir su
 * cara admin es error de COMPILACIÓN (el Record exige cubrir cada clave), no un default mudo.
 * Hoy es identidad porque el contrato admin ya expresa todos los estados de forma honesta —
 * en particular REASSIGNING (pasajero abandonado, ops DEBE intervenir), SCHEDULED, EXPIRED y
 * FAILED, que el switch anterior disfrazaba de REQUESTED/CANCELLED.
 */
const ADMIN_TRIP_STATUS: Record<TripStatus, AdminTripStatus> = {
  SCHEDULED: 'SCHEDULED',
  REQUESTED: 'REQUESTED',
  MATCHING: 'MATCHING',
  ASSIGNED: 'ASSIGNED',
  ACCEPTED: 'ACCEPTED',
  ARRIVING: 'ARRIVING',
  ARRIVED: 'ARRIVED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  REASSIGNING: 'REASSIGNING',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
};

/**
 * Normaliza el estado CRUDO de trip-service al enum de la vista OPS (@veo/api-client).
 * `normalizeTripStatus` resuelve los alias del dominio (CANCELLED_BY_* → CANCELLED) y valida contra
 * el contrato; un valor fuera del contrato se reporta como UNKNOWN honesto (visible para ops),
 * nunca como un REQUESTED falso.
 */
export function mapTripStatus(raw: string): AdminTripStatus {
  const normalized = normalizeTripStatus(raw);
  return normalized === null ? 'UNKNOWN' : ADMIN_TRIP_STATUS[normalized];
}
