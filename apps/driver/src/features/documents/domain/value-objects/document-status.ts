import type {DriverDocumentSimpleStatus} from '@veo/api-client';
import type {StatusTone} from '@veo/ui-kit';

/**
 * Estado simple de un documento (en español, listo para UI). Re-exporta el tipo del contrato para
 * que la capa de presentación dependa del dominio, no del paquete de API directamente.
 */
export type DocumentSimpleStatus = DriverDocumentSimpleStatus;

/**
 * `true` cuando el documento exige atención del conductor antes de poder operar con tranquilidad:
 * vencido, por vencer o rechazado. Se usa para priorizar/destacar en la lista.
 */
export function needsAttention(status: DocumentSimpleStatus): boolean {
  return status === 'vencido' || status === 'por_vencer' || status === 'rechazado';
}

/** `true` solo para documentos vencidos o rechazados: bloquean la operación (crítico). */
export function isBlocking(status: DocumentSimpleStatus): boolean {
  return status === 'vencido' || status === 'rechazado';
}

/**
 * Tono semántico del `StatusPill`/chip para cada estado:
 *  - vigente → success (verde)
 *  - por_vencer → warn (ámbar)
 *  - vencido / rechazado → danger (rojo)
 *  - en_revision → neutral
 */
export function documentStatusTone(status: DocumentSimpleStatus): StatusTone {
  switch (status) {
    case 'vigente':
      return 'success';
    case 'por_vencer':
      return 'warn';
    case 'vencido':
    case 'rechazado':
      return 'danger';
    case 'en_revision':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/**
 * Orden de prioridad para listar (más urgente primero): vencido → rechazado → por vencer →
 * en revisión → vigente. Menor número = más arriba.
 */
export function statusPriority(status: DocumentSimpleStatus): number {
  switch (status) {
    case 'vencido':
      return 0;
    case 'rechazado':
      return 1;
    case 'por_vencer':
      return 2;
    case 'en_revision':
      return 3;
    case 'vigente':
      return 4;
    default:
      return 5;
  }
}

/**
 * Clasifica un documento por su fecha de vencimiento ISO contra `now`, devolviendo el estado simple
 * que la UI debería mostrar. Útil cuando el servidor no precalcula `simpleStatus` (p. ej. justo tras
 * registrar un documento) o para tests de la lógica de vencimiento.
 *
 * Reglas (días naturales hasta el vencimiento):
 *  - sin fecha → `en_revision` (registro pendiente de validar, sin vencimiento conocido)
 *  - < 0 días (ya pasó) → `vencido`
 *  - ≤ `warnWithinDays` (por defecto 30) → `por_vencer`
 *  - en otro caso → `vigente`
 */
export function classifyByExpiry(
  expiresAt: string | null | undefined,
  now: Date = new Date(),
  warnWithinDays = 30,
): DocumentSimpleStatus {
  if (!expiresAt) {
    return 'en_revision';
  }
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) {
    return 'en_revision';
  }
  const msPerDay = 24 * 60 * 60 * 1000;
  // Días naturales restantes (redondeo hacia abajo): hoy mismo = 0 días, ayer = -1.
  const daysLeft = Math.floor((expiry.getTime() - now.getTime()) / msPerDay);
  if (daysLeft < 0) {
    return 'vencido';
  }
  if (daysLeft <= warnWithinDays) {
    return 'por_vencer';
  }
  return 'vigente';
}
