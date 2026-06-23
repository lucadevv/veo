/**
 * F3c FIX 3 · classifyRefundError — la clasificación TIPADA que cierra el loop de redelivery ∞ del refund
 * automático. Verifica que cada TIPO/code de error mapea a la ACCIÓN correcta (cero strings mágicos):
 *  - gateway REJECTED síncrono (UnprocessableEntityError) → rejected_settled (backstop admin, NO loop Kafka).
 *  - InvalidStateError (sin railRef / gateway sin reembolsos) → unrecoverable_no_refund (alerta, NO loop).
 *  - permanent-data (P2023) → permanent_data (veneno, NO relanzar).
 *  - transitorio (P1001 / ExternalServiceError 502 / Error crudo) → transient (relanzar, Kafka reintenta).
 */
import { describe, it, expect } from 'vitest';
import {
  ConcurrencyConflictError,
  ConflictError,
  ExternalServiceError,
  ForbiddenError,
  GatewayCapabilityUnavailableError,
  InvalidStateError,
  NotFoundError,
  UnprocessableEntityError,
  ValidationError,
} from '@veo/utils';
import { classifyRefundError } from './refund-event-classify';

describe('classifyRefundError · clasificación TIPADA del error de refund (F3c FIX 3)', () => {
  it('gateway REJECTED síncrono (UnprocessableEntityError) → rejected_settled (backstop admin, NO loop)', () => {
    const err = new UnprocessableEntityError('El proveedor rechazó el reembolso: reverse_rejected');
    expect(classifyRefundError(err)).toBe('rejected_settled');
  });

  it('GatewayCapabilityUnavailableError → rejected_settled (rechazo permanente de capacidad)', () => {
    const err = new GatewayCapabilityUnavailableError('capacidad no habilitada');
    expect(classifyRefundError(err)).toBe('rejected_settled');
  });

  it('InvalidStateError (gateway sin reembolsos / sin railRef) → unrecoverable_no_refund (alerta, NO loop)', () => {
    // Caso PERMANENTE REAL: la condición no cambia con un retry → backstop manual (NO loop Kafka).
    const err = new InvalidStateError('El gateway activo no soporta reembolsos digitales');
    expect(classifyRefundError(err)).toBe('unrecoverable_no_refund');
  });

  it('ConcurrencyConflictError (CAS miss del claim) → transient (un retry tendría éxito, NO falsa alerta de backstop)', () => {
    // CAS fail CONCURRENTE: otro refund movió el saldo entre read y write. Es REINTENTABLE — con el estado
    // fresco el reintento de Kafka tendría éxito. NO debe caer en unrecoverable (descartaría el retry válido
    // y dispararía una FALSA alerta de backstop sobre una simple carrera optimista). Distinto del
    // InvalidStateError PERMANENTE de arriba (gateway sin reembolsos / sin railRef).
    const err = new ConcurrencyConflictError('El cobro cambió de saldo por una operación concurrente (CAS)');
    expect(classifyRefundError(err)).toBe('transient');
  });

  it('permanent-data Prisma (P2023 UUID malformado) → permanent_data (veneno, NO relanzar)', () => {
    const err = Object.assign(new Error('inconsistent column data'), { code: 'P2023' });
    expect(classifyRefundError(err)).toBe('permanent_data');
  });

  it('ExternalServiceError (502 upstream) → transient (reintentable, NO se trata como no-recuperable)', () => {
    const err = new ExternalServiceError('upstream degradado');
    expect(classifyRefundError(err)).toBe('transient');
  });

  it('error transitorio Prisma (P1001 DB inalcanzable) → transient (relanzar)', () => {
    const err = Object.assign(new Error('cannot reach database'), { code: 'P1001' });
    expect(classifyRefundError(err)).toBe('transient');
  });

  it('deadlock Prisma (P2034) → transient (relanzar)', () => {
    const err = Object.assign(new Error('write conflict'), { code: 'P2034' });
    expect(classifyRefundError(err)).toBe('transient');
  });

  it('Error crudo / desconocido → transient (fail closed hacia el retry)', () => {
    expect(classifyRefundError(new Error('ECONNREFUSED'))).toBe('transient');
    expect(classifyRefundError(undefined)).toBe('transient');
    expect(classifyRefundError('boom')).toBe('transient');
  });

  it('otros DomainError no-transitorios (Validation/Forbidden/Conflict/NotFound) → unrecoverable_no_refund (NO loop)', () => {
    // No dejaron Refund recuperable y reintentar no los resuelve → backstop manual, jamás loop ∞.
    expect(classifyRefundError(new ValidationError('x'))).toBe('unrecoverable_no_refund');
    expect(classifyRefundError(new ForbiddenError('x'))).toBe('unrecoverable_no_refund');
    expect(classifyRefundError(new ConflictError('x'))).toBe('unrecoverable_no_refund');
    expect(classifyRefundError(new NotFoundError('x'))).toBe('unrecoverable_no_refund');
  });
});
