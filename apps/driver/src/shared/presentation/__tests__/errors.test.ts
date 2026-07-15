import { ApiError } from '@veo/api-client';
import { isConflictError, isNetworkError } from '../errors';

/**
 * FIX C · El registro de documento, en un RETRY legítimo del flujo "escaneá y listo", recibe del backend un
 * 409 ConflictError ("Ya existe un documento activo de ese tipo"): el documento YA está registrado, así que
 * la pantalla lo trata como ÉXITO (marca "Capturado ✓"), NO como error. La decisión se toma con el predicado
 * tipado `isConflictError` (status 409 / `ApiError`), SIN matchear el texto del mensaje del backend.
 */
describe('shared/errors · isConflictError (FIX C · 409-como-éxito)', () => {
  it('ApiError 409 (documento ya registrado) → isConflictError true (se trata como subido)', () => {
    const conflict = new ApiError(
      409,
      'CONFLICT',
      'Ya existe un documento activo de ese tipo para el dueño',
    );
    expect(isConflictError(conflict)).toBe(true);
  });

  it('matchea por STATUS 409, no por el texto del mensaje (sin string mágico)', () => {
    const conflict = new ApiError(409, 'HTTP_ERROR', 'cualquier mensaje distinto');
    expect(isConflictError(conflict)).toBe(true);
  });

  it('NO confunde otros errores con un conflicto: 400/422/500/red → false', () => {
    expect(isConflictError(new ApiError(400, 'BAD_REQUEST', 'x'))).toBe(false);
    expect(isConflictError(new ApiError(422, 'VALIDATION', 'x'))).toBe(false);
    expect(isConflictError(new ApiError(500, 'INTERNAL', 'x'))).toBe(false);
    expect(isConflictError(new ApiError(0, 'NETWORK', 'sin red'))).toBe(false);
  });

  it('un error NO-ApiError (Error genérico) → false (no se trata como "ya está")', () => {
    expect(isConflictError(new Error('boom'))).toBe(false);
    expect(isConflictError(null)).toBe(false);
    expect(isConflictError(undefined)).toBe(false);
  });

  it('un 409 NO es un error de red (no se reintenta como transitorio)', () => {
    const conflict = new ApiError(409, 'CONFLICT', 'ya existe');
    expect(isNetworkError(conflict)).toBe(false);
  });
});
