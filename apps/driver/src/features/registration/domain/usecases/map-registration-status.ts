import type { DriverProfileView } from '@veo/api-client';
import type { RegistrationStatus } from '../entities';

/**
 * Estados crudos (identity/fleet) que consideramos RECHAZO definitivo del KYC o de antecedentes.
 * Tolerante a mayúsculas/variantes; el backend manda strings libres.
 */
const REJECTED_TOKENS = ['REJECTED', 'FAILED', 'DENIED', 'BLOCKED'];

/** Estados crudos que consideramos APROBADO/verificado para el KYC y antecedentes. */
// 'CLEARED' es el valor canónico de identity (enum BackgroundCheckStatus: PENDING|CLEARED|REJECTED).
const APPROVED_TOKENS = ['APPROVED', 'VERIFIED', 'CLEAR', 'CLEARED', 'PASSED', 'OK', 'COMPLETED'];

function normalize(raw: string): string {
  return raw.trim().toUpperCase();
}

function isRejected(raw: string): boolean {
  return REJECTED_TOKENS.includes(normalize(raw));
}

function isApproved(raw: string): boolean {
  return APPROVED_TOKENS.includes(normalize(raw));
}

/**
 * Proyecta el perfil agregado del conductor (`GET /drivers/me`) al estado de alta que conmuta la
 * navegación raíz. Reglas (documentadas por intención de negocio):
 *
 *  1. RECHAZO → `rejected`: si el KYC o los antecedentes están rechazados, el conductor debe
 *     corregir su alta (vuelve al wizard para re-subir lo observado).
 *  2. APROBADO → `approved`: documentación COMPLETA (`compliance.compliant`) y ni KYC ni
 *     antecedentes rechazados ⇒ entra a la app (tabs). Es la regla que evita "atrapar" a un
 *     conductor ya aprobado en el wizard solo porque el estado local venía en `not_started`.
 *  3. EN REVISIÓN → `in_review`: ya envió lo necesario pero el backend aún valida — hay documentos
 *     en revisión, o el KYC/antecedentes no están ni aprobados ni rechazados (pendientes), o no
 *     faltan documentos pero todavía no está marcado como `compliant`.
 *  4. WIZARD → `not_started`: faltan documentos (`compliance.missing` no vacío) ⇒ aún no completó el
 *     alta. El store decide si conserva el progreso local (`in_progress`) o arranca el wizard.
 */
export function mapProfileToRegistrationStatus(profile: DriverProfileView): RegistrationStatus {
  const { kycStatus, backgroundCheckStatus, compliance, documents } = profile;

  // 1) Rechazo de identidad/antecedentes: el conductor debe corregir.
  if (isRejected(kycStatus) || isRejected(backgroundCheckStatus)) {
    return 'rejected';
  }

  // 4) Faltan documentos requeridos ⇒ todavía no terminó el alta.
  if (compliance.missing.length > 0) {
    return 'not_started';
  }

  // 2) Documentación al día + identidad/antecedentes sin rechazo ⇒ aprobado.
  const identityClear = isApproved(kycStatus) && isApproved(backgroundCheckStatus);
  if (compliance.compliant && identityClear) {
    return 'approved';
  }

  // 3) Cumple documentación pero falta validación (docs en revisión o KYC/antecedentes pendientes).
  const hasDocsInReview = documents.some((doc) => !doc.ok);
  if (compliance.compliant || hasDocsInReview || !identityClear) {
    return 'in_review';
  }

  // Por defecto, conservador: en revisión (nunca mandamos al wizard si no faltan documentos).
  return 'in_review';
}
