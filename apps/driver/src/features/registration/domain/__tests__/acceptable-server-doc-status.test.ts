import { FleetDocumentStatus } from '@veo/shared-types';
import { isAcceptableServerDocStatus } from '../entities';

/**
 * Predicado de dominio que decide qué estados CRUDOS de `FleetDocumentStatus` cuentan como "documento
 * presente y aceptable" para avanzar el alta (gate "Continuar" del paso 3). Un doc VENCIDO o RECHAZADO
 * NO cuenta: hay que re-subirlo, igual que uno faltante. Un estado desconocido cae en "no cuenta"
 * (default seguro). Espeja la lógica del chip rojo (vencido/rechazado → danger).
 */
describe('isAcceptableServerDocStatus', () => {
  it('cuenta PENDING_REVIEW (subido, en revisión)', () => {
    expect(isAcceptableServerDocStatus(FleetDocumentStatus.PENDING_REVIEW)).toBe(true);
  });

  it('cuenta VALID (aprobado y vigente)', () => {
    expect(isAcceptableServerDocStatus(FleetDocumentStatus.VALID)).toBe(true);
  });

  it('cuenta EXPIRING_SOON (aún vigente)', () => {
    expect(isAcceptableServerDocStatus(FleetDocumentStatus.EXPIRING_SOON)).toBe(true);
  });

  it('NO cuenta EXPIRED: vencido → re-subir', () => {
    expect(isAcceptableServerDocStatus(FleetDocumentStatus.EXPIRED)).toBe(false);
  });

  it('NO cuenta REJECTED: rechazado → re-subir', () => {
    expect(isAcceptableServerDocStatus(FleetDocumentStatus.REJECTED)).toBe(false);
  });

  it('NO cuenta un estado desconocido (default seguro)', () => {
    expect(isAcceptableServerDocStatus('SOMETHING_NEW')).toBe(false);
    expect(isAcceptableServerDocStatus('')).toBe(false);
  });
});
