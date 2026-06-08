import type { FamilyTrackingView } from '@veo/api-client';

/**
 * Estado derivado del link de seguimiento, independiente de la capa de transporte.
 * Cada variante mapea a una pantalla clara y tranquilizadora (no errores crudos).
 */
export type ShareState =
  | { kind: 'active'; view: FamilyTrackingView }
  | { kind: 'ended'; view: FamilyTrackingView }
  | { kind: 'revoked' }
  | { kind: 'expired' }
  | { kind: 'invalid' }
  | { kind: 'unavailable' };

/** Clasifica una vista válida según sus campos (revocado, expiración, viaje terminado). */
export function classifyView(view: FamilyTrackingView, now: number = Date.now()): ShareState {
  if (view.revoked) return { kind: 'revoked' };

  const expiresAt = Date.parse(view.expiresAt);
  if (!Number.isNaN(expiresAt) && expiresAt <= now) return { kind: 'expired' };

  if (view.status === 'COMPLETED' || view.status === 'CANCELLED') {
    return { kind: 'ended', view };
  }

  return { kind: 'active', view };
}

/** Traduce un error HTTP del bff a un estado de pantalla. */
export function classifyError(status: number, code?: string): ShareState {
  const normalized = (code ?? '').toUpperCase();
  if (status === 410 || normalized.includes('EXPIRED')) return { kind: 'expired' };
  if (status === 403 || normalized.includes('REVOKED') || normalized.includes('FORBIDDEN')) {
    return { kind: 'revoked' };
  }
  if (status === 404 || normalized.includes('NOT_FOUND') || normalized.includes('INVALID')) {
    return { kind: 'invalid' };
  }
  return { kind: 'unavailable' };
}
