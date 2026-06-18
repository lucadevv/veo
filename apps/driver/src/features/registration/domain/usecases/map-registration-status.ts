import { FleetDocumentStatus } from '@veo/shared-types';
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
 * navegación raíz. Modela el CICLO DE VIDA REAL de cada documento requerido, que tiene TRES estados:
 * no-enviado → enviado/PENDING_REVIEW (esperando al operador) → aprobado/VALID. El bug histórico
 * confundía "faltante" con "enviado pero en revisión" y atrapaba al conductor en el wizard.
 *
 * Reglas (en orden, documentadas por intención de negocio):
 *
 *  1. RECHAZO → `rejected`: KYC o antecedentes rechazados, O algún documento requerido rechazado por
 *     el operador (`compliance.rejected`). El conductor debe corregir-y-reenviar.
 *  2. WIZARD → `not_started`: falta SUBIR algún documento requerido (`compliance.missing` no vacío,
 *     i.e. genuinamente ausente). El store decide si conserva progreso local (`in_progress`).
 *  3. APROBADO → `approved`: TODOS los documentos requeridos aprobados (`compliance.allApproved`) +
 *     KYC verificado + antecedentes CLEARED ⇒ entra a la app (tabs).
 *  4. EN REVISIÓN → `in_review`: ya envió TODO lo requerido (`compliance.submittedAllRequired`) pero
 *     el backend aún valida — hay documentos en revisión o los antecedentes/KYC siguen pendientes.
 *     Este es el camino del conductor con 3 docs PENDING_REVIEW + backgroundCheck PENDING.
 *
 * Nota: la biometría (rostro de referencia) se enrola en el paso 4 del wizard ANTES de poder enviar
 * los documentos, así que "todos los documentos enviados" implica que el enrolamiento ya ocurrió; no
 * hace falta un check biométrico separado para `in_review` (el perfil no expone `faceEnrolledAt`).
 */
export function mapProfileToRegistrationStatus(profile: DriverProfileView): RegistrationStatus {
  const { kycStatus, backgroundCheckStatus, compliance, documents } = profile;

  // 1) Rechazo: identidad/antecedentes rechazados, o algún documento requerido rechazado por el operador.
  const hasRejectedDoc =
    compliance.rejected.length > 0 ||
    documents.some((doc) => doc.status === FleetDocumentStatus.REJECTED);
  if (isRejected(kycStatus) || isRejected(backgroundCheckStatus) || hasRejectedDoc) {
    return 'rejected';
  }

  // 2) Falta SUBIR algún documento requerido (presencia) ⇒ todavía no terminó el alta.
  if (!compliance.submittedAllRequired) {
    return 'not_started';
  }

  // 3) Todo aprobado + identidad/antecedentes verificados ⇒ aprobado (entra a la app).
  const identityClear = isApproved(kycStatus) && isApproved(backgroundCheckStatus);
  if (compliance.allApproved && identityClear) {
    return 'approved';
  }

  // 4) Envió todo lo requerido pero falta validación (docs en revisión o KYC/antecedentes pendientes).
  //    Conservador: si no faltan documentos por subir y no hay rechazo, NUNCA volvemos al wizard.
  return 'in_review';
}
