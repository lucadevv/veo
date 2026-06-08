import { ApiError } from '@veo/api-client';
import { classifyOAuthError } from '../src/features/auth/presentation/hooks/useOAuthFlow';

/**
 * El clasificador mapea el error crudo del login social al `OAuthErrorKind` que la UI usa para el
 * Banner. La cancelación NO llega acá (la maneja el flujo devolviendo `{ cancelled: true }`).
 */
describe('classifyOAuthError', () => {
  it('sin error → null (no pinta Banner)', () => {
    expect(classifyOAuthError(null)).toBeNull();
    expect(classifyOAuthError(undefined)).toBeNull();
  });

  it('backend 401 → invalidAccount', () => {
    expect(classifyOAuthError(new ApiError(401, 'UNAUTHORIZED', 'no autorizado'))).toBe(
      'invalidAccount',
    );
  });

  it('backend 403 → invalidAccount', () => {
    expect(classifyOAuthError(new ApiError(403, 'FORBIDDEN', 'prohibido'))).toBe(
      'invalidAccount',
    );
  });

  it('sin conexión (status 0) → network', () => {
    expect(classifyOAuthError(new ApiError(0, 'NETWORK', 'sin red'))).toBe('network');
  });

  it('error de servidor (5xx) → network', () => {
    expect(classifyOAuthError(new ApiError(503, 'UNAVAILABLE', 'caído'))).toBe('network');
  });

  it('error genérico → unknown', () => {
    expect(classifyOAuthError(new Error('boom'))).toBe('unknown');
  });
});
