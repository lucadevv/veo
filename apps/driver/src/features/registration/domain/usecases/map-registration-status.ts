import { FleetDocumentStatus } from '@veo/shared-types';
import type { DriverProfileView } from '@veo/api-client';
import { RegistrationStatus } from '../entities';

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
 *  4. EN REVISIÓN → `in_review`: ya envió TODO lo requerido (`compliance.submittedAllRequired`) Y
 *     enroló su biometría facial (`compliance.biometricEnrolled`) — está LISTO para revisión, aunque
 *     el backend aún valide (docs en revisión o antecedentes/KYC pendientes). Camino del conductor con
 *     3 docs PENDING_REVIEW + backgroundCheck PENDING + biometría enrolada.
 *
 * Biometría: es un EJE SEPARADO e INDEPENDIENTE de los documentos (server-truth: el conductor está
 * listo para `in_review` solo si `submittedAllRequired && biometricEnrolled`). Subir todos los
 * documentos NO implica que el enrolamiento ya ocurrió: se chequea EXPLÍCITAMENTE. Si los documentos
 * están completos pero falta la biometría (`biometricEnrolled === false`), el conductor NO pasa a
 * `in_review`: vuelve al wizard como `in_progress` para completar el KYC (paso 4 / IdentityVerification).
 */
export function mapProfileToRegistrationStatus(profile: DriverProfileView): RegistrationStatus {
  const { kycStatus, backgroundCheckStatus, compliance, documents } = profile;

  // 1) Rechazo: identidad/antecedentes rechazados, o algún documento requerido rechazado por el operador.
  const hasRejectedDoc =
    compliance.rejected.length > 0 ||
    documents.some((doc) => doc.status === FleetDocumentStatus.REJECTED);
  if (isRejected(kycStatus) || isRejected(backgroundCheckStatus) || hasRejectedDoc) {
    return RegistrationStatus.REJECTED;
  }

  // 2) Falta SUBIR algún documento requerido (presencia) ⇒ todavía no terminó el alta.
  if (!compliance.submittedAllRequired) {
    return RegistrationStatus.NOT_STARTED;
  }

  // 3) Todo aprobado + identidad/antecedentes verificados ⇒ aprobado (entra a la app).
  const identityClear = isApproved(kycStatus) && isApproved(backgroundCheckStatus);
  if (compliance.allApproved && identityClear) {
    return RegistrationStatus.APPROVED;
  }

  // 4) Subió todos los documentos PERO aún no enroló la biometría (eje SEPARADO). NO está listo para
  //    revisión: vuelve al wizard como `in_progress` para completar el KYC (paso 4 / IdentityVerification).
  //    Defense-in-depth en el cliente: el reflejo del server-truth `submittedAllRequired && biometricEnrolled`.
  if (!compliance.biometricEnrolled) {
    return RegistrationStatus.IN_PROGRESS;
  }

  // 5) Envió todo lo requerido Y enroló su biometría, pero falta validación (docs en revisión o
  //    KYC/antecedentes pendientes). Listo para revisión: no volvemos al wizard.
  return RegistrationStatus.IN_REVIEW;
}

/**
 * ¿El alta está EN REVISIÓN (envió todo, espera la validación del backend)? Predicado de DOMINIO para
 * que la UI sondee como RED DE SEGURIDAD mientras espera — el push de aprobación/rechazo es best-effort
 * (puede no llegar: Firebase sin configurar, permiso denegado, red flaky), así que el conductor debe
 * enterarse SÍ o SÍ. El literal del estado vive UNA vez (junto a su mapeo canónico), no esparcido.
 */
export function isAwaitingReview(status: RegistrationStatus): boolean {
  return status === RegistrationStatus.IN_REVIEW;
}
