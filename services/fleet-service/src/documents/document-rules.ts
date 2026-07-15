/**
 * Reglas de dominio puras de documentos de flota (BR-I04). Sin I/O ni dependencias de Nest:
 * funciones puras y deterministas → 100% testeables. La capa de servicio/cron las orquesta.
 */
import { ValidationError, ForbiddenError } from '@veo/utils';
import { FleetDocumentStatus, FleetDocumentType } from '@veo/shared-types';
import { DocumentSide, FleetOwnerType } from '../generated/prisma';

const MS_PER_DAY = 86_400_000;

/** Estado derivable del vencimiento (lo recalcula el cron). El resto es revisión manual. */
export type ExpiryStatus = Extract<FleetDocumentStatus, 'VALID' | 'EXPIRING_SOON' | 'EXPIRED'>;

/** Documentos críticos: si vencen, el conductor se suspende (BR-I04). */
export const CRITICAL_DOCUMENT_TYPES: readonly FleetDocumentType[] = [
  FleetDocumentType.LICENSE_A1,
  FleetDocumentType.SOAT,
  FleetDocumentType.PROPERTY_CARD,
];

/** Estados cuyo valor se deriva del vencimiento; PENDING_REVIEW y REJECTED son manuales. */
export const EXPIRY_TRACKED_STATUSES: readonly FleetDocumentStatus[] = [
  FleetDocumentStatus.VALID,
  FleetDocumentStatus.EXPIRING_SOON,
  FleetDocumentStatus.EXPIRED,
];

export function isCriticalDocument(type: FleetDocumentType): boolean {
  return CRITICAL_DOCUMENT_TYPES.includes(type);
}

export function isExpiryTracked(status: FleetDocumentStatus): boolean {
  return EXPIRY_TRACKED_STATUSES.includes(status);
}

/**
 * B5-3.2 · Certificaciones de operador de las verticales especiales (conductor). A diferencia de los docs
 * base, NO son críticas: su vencimiento NO suspende al conductor — solo lo vuelve inelegible para ESA
 * vertical (que además está oculta). Una vertical exige la suya vía OfferingRequirements.certifications.
 */
export const CERTIFICATION_TYPES: readonly FleetDocumentType[] = [
  FleetDocumentType.AMBULANCE_OPERATOR,
  FleetDocumentType.TOW_OPERATOR,
  FleetDocumentType.MECHANIC_CERT,
];

/** Estados en que una credencial está VIGENTE (operable): EXPIRING_SOON sigue vigente; EXPIRED/RECHAZADO no. */
export const VALID_DOCUMENT_STATUSES: readonly FleetDocumentStatus[] = [
  FleetDocumentStatus.VALID,
  FleetDocumentStatus.EXPIRING_SOON,
];

export function isCertification(type: FleetDocumentType): boolean {
  return CERTIFICATION_TYPES.includes(type);
}

export function isDocumentValid(status: FleetDocumentStatus): boolean {
  return VALID_DOCUMENT_STATUSES.includes(status);
}

/**
 * B5-3.2 · las certificaciones de vertical VÁLIDAS (tipo de cert ∧ estado vigente) que tiene un conductor.
 * Pura, sin I/O: el caller trae los documentos (DocumentsService.listByOwner) y esta función destila la lista
 * de certs que viaja a dispatch para la eligibilidad FAIL-CLOSED (requires.certifications ⊆ ésta). Excluye los
 * docs base (licencia/SOAT) — solo certs de vertical — para que el ping no cargue credenciales irrelevantes.
 */
export function validCertificationsOf(
  docs: readonly { type: FleetDocumentType; status: FleetDocumentStatus }[],
): FleetDocumentType[] {
  return docs
    .filter((d) => isCertification(d.type) && isDocumentValid(d.status))
    .map((d) => d.type);
}

/* ── Sub-lote 3A · imágenes del documento (1..N) ────────────────────────────────────────────── */

/** Imagen de entrada (del DTO o del legacy `fileS3Key`): clave S3 + cara. */
export interface DocumentImageInput {
  s3Key: string;
  side: DocumentSide;
}

/** Imagen ya normalizada para persistir: clave + cara + orden estable (0-based). */
export interface NormalizedDocumentImage {
  s3Key: string;
  side: DocumentSide;
  order: number;
}

/**
 * Normaliza y VALIDA las imágenes de un documento (sub-lote 3A), de forma pura y determinista.
 *
 * Fuentes (en prioridad): `images` (camino nuevo, 1..N) o, si viene vacío, el legacy `fileS3Key`
 * (backward-compat) → una sola imagen SINGLE. Si no hay ninguna fuente, devuelve [] (el documento
 * puede registrarse sin archivo aún, como hoy).
 *
 * Reglas de coherencia de `side` (tipadas, sin string mágico):
 *  - Si alguna imagen es FRONT o BACK → debe ser EXACTAMENTE un par {FRONT, BACK} (anverso+reverso,
 *    p.ej. DNI). Ni FRONT solo, ni BACK solo, ni FRONT/BACK mezclados con SINGLE, ni duplicados.
 *  - Si TODAS son SINGLE → cualquier cantidad ≥ 1 es válida (licencia/SOAT/tarjeta = 1; foto de vehículo = N).
 *
 * El `order` se asigna por posición de entrada (0-based), salvo el par FRONT/BACK, que se fuerza a
 * FRONT=0, BACK=1 (orden canónico estable, independiente del orden en que el cliente las mande).
 */
export function normalizeDocumentImages(input: {
  images?: readonly DocumentImageInput[] | null;
  fileS3Key?: string | null;
}): NormalizedDocumentImage[] {
  const fromImages = input.images ?? [];

  // Sin `images`: degradación al legacy `fileS3Key` (una imagen SINGLE). Sin ninguno: documento sin archivo.
  if (fromImages.length === 0) {
    if (input.fileS3Key) {
      return [{ s3Key: input.fileS3Key, side: DocumentSide.SINGLE, order: 0 }];
    }
    return [];
  }

  const hasFrontOrBack = fromImages.some(
    (i) => i.side === DocumentSide.FRONT || i.side === DocumentSide.BACK,
  );

  if (!hasFrontOrBack) {
    // Todas SINGLE: N imágenes ordenadas por posición (foto de vehículo, o 1 sola cara).
    return fromImages.map((i, order) => ({ s3Key: i.s3Key, side: DocumentSide.SINGLE, order }));
  }

  // Hay FRONT/BACK: exigir el par exacto {FRONT, BACK} (anverso+reverso, sin SINGLE mezclado ni duplicados).
  const front = fromImages.filter((i) => i.side === DocumentSide.FRONT);
  const back = fromImages.filter((i) => i.side === DocumentSide.BACK);
  const single = fromImages.filter((i) => i.side === DocumentSide.SINGLE);
  const frontImage = front[0];
  const backImage = back[0];
  if (
    front.length !== 1 ||
    back.length !== 1 ||
    single.length !== 0 ||
    fromImages.length !== 2 ||
    !frontImage ||
    !backImage
  ) {
    throw new ValidationError(
      'Caras incoherentes: un documento de dos caras requiere exactamente un FRONT y un BACK, sin SINGLE',
      {
        front: front.length,
        back: back.length,
        single: single.length,
        total: fromImages.length,
      },
    );
  }
  // Orden canónico estable: FRONT=0, BACK=1 (independiente del orden de envío del cliente).
  return [
    { s3Key: frontImage.s3Key, side: DocumentSide.FRONT, order: 0 },
    { s3Key: backImage.s3Key, side: DocumentSide.BACK, order: 1 },
  ];
}

/** La clave S3 "legacy" (la primera imagen por orden) para mantener `fileS3Key` poblado backward-compat. */
export function primaryS3Key(images: readonly NormalizedDocumentImage[]): string | null {
  const first = images[0];
  if (!first) return null;
  return images.reduce((min, i) => (i.order < min.order ? i : min), first).s3Key;
}

/**
 * Anti-IDOR de STORAGE (Ley 29733, defensa en profundidad · FOUNDATION §14): el prefijo S3 que un
 * documento puede referenciar está ACOTADO al dueño. Un conductor solo puede registrar un doc cuyas
 * keys vivan bajo SU propio prefijo `drivers/{ownerId}/` — el mismo que el presign genera server-side
 * (driver-bff `buildDocumentKey`). Sin esto, un cliente podía mandar un `s3Key` apuntando a
 * `drivers/{OTRO}/documents/...` y, al presignar el operador un GET de esa key, ver PII ajena.
 *
 * El prefijo NO es un literal de dominio suelto: se CONSTRUYE del `ownerType`+`ownerId` (la frontera es
 * el id del dueño, no una cadena mágica). Espeja el patrón ya existente de `avatar.service.assertOwnsKey`
 * (`avatars/${userId}/`). Para `ownerType` que aún no tiene un prefijo storage acotado (p.ej. VEHICLE,
 * cuyo onboarding driver-scoped no emite keys vehicle-scoped) devuelve `null`: no se fuerza un prefijo
 * que no corresponde (no romper el flujo legítimo), la pertenencia del owner ya la cubre `create`.
 */
export function expectedS3KeyPrefix(ownerType: FleetOwnerType, ownerId: string): string | null {
  if (ownerType === FleetOwnerType.DRIVER) return `drivers/${ownerId}/`;
  return null;
}

/**
 * Valida que TODAS las claves S3 de un documento (las imágenes ya normalizadas) pertenezcan al prefijo
 * del dueño. Fail-closed: si alguna key no arranca con el prefijo esperado → ForbiddenError (403). Si el
 * `ownerType` no tiene prefijo acotado (`expectedS3KeyPrefix` → null), es no-op (no aplica este riel).
 */
export function assertS3KeysBelongToOwner(
  ownerType: FleetOwnerType,
  ownerId: string,
  images: readonly NormalizedDocumentImage[],
): void {
  const prefix = expectedS3KeyPrefix(ownerType, ownerId);
  if (prefix === null) return;
  for (const img of images) {
    if (!img.s3Key.startsWith(prefix)) {
      throw new ForbiddenError('La clave de archivo no pertenece al dueño del documento', {
        ownerType,
        ownerId,
        s3Key: img.s3Key,
      });
    }
  }
}

/** Días (fraccionarios) hasta el vencimiento. Negativo si ya pasó. */
export function daysUntil(expiresAt: Date, now: Date): number {
  return (expiresAt.getTime() - now.getTime()) / MS_PER_DAY;
}

/** Días restantes redondeados hacia arriba (para alinear los hitos de alerta con el cron diario). */
export function daysUntilCeil(expiresAt: Date, now: Date): number {
  return Math.ceil(daysUntil(expiresAt, now));
}

/**
 * BR-I04: estado del documento derivado de `expiresAt`.
 * - sin vencimiento (p.ej. antecedentes aprobados) → VALID
 * - vencido (instante pasado) → EXPIRED
 * - faltan ≤ warningDays → EXPIRING_SOON
 * - en otro caso → VALID
 * Frontera: exactamente `warningDays` días → EXPIRING_SOON; exactamente 0 días (aún no pasa) → EXPIRING_SOON.
 */
export function deriveExpiryStatus(
  expiresAt: Date | null | undefined,
  now: Date,
  warningDays = 30,
): ExpiryStatus {
  if (!expiresAt) return FleetDocumentStatus.VALID;
  const remaining = daysUntil(expiresAt, now);
  if (remaining < 0) return FleetDocumentStatus.EXPIRED;
  if (remaining <= warningDays) return FleetDocumentStatus.EXPIRING_SOON;
  return FleetDocumentStatus.VALID;
}

/**
 * Hito de alerta vigente para `daysRemaining` dado el set de hitos (30/15/7/1).
 * Devuelve el hito más ajustado (menor) ya alcanzado, o null si aún no entra en ninguno o ya venció.
 */
export function dueExpiryMilestone(
  daysRemaining: number,
  milestones: readonly number[],
): number | null {
  if (daysRemaining <= 0) return null;
  const reached = milestones.filter((m) => daysRemaining <= m);
  if (reached.length === 0) return null;
  return Math.min(...reached);
}

export interface ExpiryAlertInput {
  expiresAt: Date | null | undefined;
  now: Date;
  milestones: readonly number[];
  /** Último hito (en días) ya alertado para este documento; evita duplicar. */
  alreadyAlertedDays: number | null;
}

/**
 * BR-I04 alertas: decide si hoy corresponde emitir una alerta de vencimiento y a qué hito.
 * Cada hito se alerta una sola vez (se memoriza `alreadyAlertedDays`). Devuelve el hito o null.
 */
export function computeExpiryAlert(input: ExpiryAlertInput): number | null {
  if (!input.expiresAt) return null;
  const milestone = dueExpiryMilestone(daysUntilCeil(input.expiresAt, input.now), input.milestones);
  if (milestone === null) return null;
  // Ya alertamos este hito (o uno más ajustado): no repetir.
  if (input.alreadyAlertedDays !== null && input.alreadyAlertedDays <= milestone) return null;
  return milestone;
}

/**
 * BR-I04 suspensión: hay que suspender al conductor si alguno de sus documentos críticos está EXPIRED.
 */
export function shouldSuspendDriver(
  docs: readonly { type: FleetDocumentType; status: FleetDocumentStatus }[],
): boolean {
  return docs.some((d) => isCriticalDocument(d.type) && d.status === FleetDocumentStatus.EXPIRED);
}
