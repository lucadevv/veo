/**
 * Puerto de verificación de antecedentes (RENIEC / proveedor externo).
 *
 * FASE ACTUAL: revisión MANUAL del operador (endpoint POST /documents/:id/review con RBAC).
 * El documento BACKGROUND_CHECK entra como PENDING_REVIEW y un COMPLIANCE_SUPERVISOR/ADMIN lo
 * pasa a VALID o REJECTED. La integración automática (consulta live a RENIEC/antecedentes) es
 * FASE 4: se implementará un adaptador `LiveBackgroundCheckProvider` que cumpla este puerto sin
 * tocar el resto del servicio (principio O/D de SOLID). Hoy NO hay implementación live.
 */

export interface BackgroundCheckQuery {
  /** Hash del DNI (nunca el DNI en claro — Ley 29733). */
  dniHash: string;
  documentNumber: string;
}

export type BackgroundCheckOutcome = 'CLEARED' | 'REJECTED' | 'INCONCLUSIVE';

export interface BackgroundCheckResult {
  outcome: BackgroundCheckOutcome;
  reference: string;
  checkedAt: string;
}

/** Contrato del proveedor de antecedentes. Inyectable por DI cuando exista el adaptador live. */
export interface BackgroundCheckProvider {
  verify(query: BackgroundCheckQuery): Promise<BackgroundCheckResult>;
}

export const BACKGROUND_CHECK_PROVIDER = Symbol('BACKGROUND_CHECK_PROVIDER');
