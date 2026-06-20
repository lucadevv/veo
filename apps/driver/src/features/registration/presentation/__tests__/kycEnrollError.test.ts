import { ApiError } from '@veo/api-client';
import { classifyKycEnrollError } from '../kycEnrollError';

describe('classifyKycEnrollError · mapeo del error de confirmar KYC', () => {
  it('clasifica un 422 directo como "face" (rostro no procesable)', () => {
    const err = new ApiError(422, 'UNPROCESSABLE_ENTITY', 'La imagen debe contener un rostro');
    expect(classifyKycEnrollError(err)).toBe('face');
  });

  it('clasifica como "face" cuando el 422 viaja embebido en details (502 EXTERNAL actual)', () => {
    // Hoy identity-service colapsa el 422 del biometric-service a 502 EXTERNAL pero deja el original
    // en details.status; ese es el puente para distinguir "rostro" sin esperar un cambio de backend.
    const err = new ApiError(502, 'EXTERNAL', 'biometric-service devolvió error', { status: 422 });
    expect(classifyKycEnrollError(err)).toBe('face');
  });

  it('clasifica un fallo de red (status 0) como "network"', () => {
    const err = new ApiError(0, 'NETWORK', 'sin conexión');
    expect(classifyKycEnrollError(err)).toBe('network');
  });

  it('clasifica un 502 EXTERNAL sin pista de rostro como "generic"', () => {
    const err = new ApiError(502, 'EXTERNAL', 'biometric-service no respondió a tiempo');
    expect(classifyKycEnrollError(err)).toBe('generic');
  });

  it('clasifica un 500 genérico como "generic"', () => {
    const err = new ApiError(500, 'INTERNAL', 'algo salió mal');
    expect(classifyKycEnrollError(err)).toBe('generic');
  });

  it('clasifica un error desconocido (no ApiError) como "generic"', () => {
    expect(classifyKycEnrollError(new Error('boom'))).toBe('generic');
    expect(classifyKycEnrollError(null)).toBe('generic');
  });
});
