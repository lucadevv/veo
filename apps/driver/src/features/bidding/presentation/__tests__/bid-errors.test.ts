import { ApiError } from '@veo/api-client';
import { isBidGoneError } from '../bid-errors';

describe('isBidGoneError', () => {
  it('true cuando la puja ya no está: 409 (board cerrado) y 404 (board inexistente)', () => {
    expect(isBidGoneError(ApiError.fromResponse(409, null))).toBe(true);
    expect(isBidGoneError(ApiError.fromResponse(404, null))).toBe(true);
  });

  it('false para otros errores (400 validación, 403 no elegible, red, genérico, null)', () => {
    expect(isBidGoneError(ApiError.fromResponse(400, null))).toBe(false);
    expect(isBidGoneError(ApiError.fromResponse(403, null))).toBe(false);
    expect(isBidGoneError(ApiError.fromResponse(0, null))).toBe(false); // red
    expect(isBidGoneError(new Error('boom'))).toBe(false);
    expect(isBidGoneError(null)).toBe(false);
  });
});
