import { describe, it, expect } from 'vitest';
import { status } from '@grpc/grpc-js';
import { isPermanentGrpcError } from './grpc-poison.js';

describe('isPermanentGrpcError', () => {
  it('PERMISSION_DENIED (riel/audiencia no autorizada) → PERMANENTE', () => {
    expect(isPermanentGrpcError({ code: status.PERMISSION_DENIED })).toBe(true);
  });

  it('INVALID_ARGUMENT / UNIMPLEMENTED / UNAUTHENTICATED → PERMANENTES (contrato/config)', () => {
    expect(isPermanentGrpcError({ code: status.INVALID_ARGUMENT })).toBe(true);
    expect(isPermanentGrpcError({ code: status.UNIMPLEMENTED })).toBe(true);
    expect(isPermanentGrpcError({ code: status.UNAUTHENTICATED })).toBe(true);
  });

  it('UNAVAILABLE / DEADLINE_EXCEEDED / RESOURCE_EXHAUSTED → TRANSITORIOS (reintentar)', () => {
    expect(isPermanentGrpcError({ code: status.UNAVAILABLE })).toBe(false);
    expect(isPermanentGrpcError({ code: status.DEADLINE_EXCEEDED })).toBe(false);
    expect(isPermanentGrpcError({ code: status.RESOURCE_EXHAUSTED })).toBe(false);
  });

  it('error SIN code numérico (no-gRPC) → false (defaultea a reintentar, lado seguro)', () => {
    expect(isPermanentGrpcError(new Error('boom'))).toBe(false);
    expect(isPermanentGrpcError({ code: 'PERMISSION_DENIED' })).toBe(false); // string, no number
    expect(isPermanentGrpcError(null)).toBe(false);
    expect(isPermanentGrpcError(undefined)).toBe(false);
  });
});
