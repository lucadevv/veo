/** Tests de validación de DTOs (class-validator) en los límites públicos. */
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RequestOtpDto, VerifyOtpDto } from '../auth/dto/auth.dto';
import { CreateTripDto } from '../trips/dto/trip.dto';

function errorsOf<T extends object>(cls: new () => T, payload: unknown): string[] {
  const dto = plainToInstance(cls, payload);
  return validateSync(dto as object, { whitelist: true }).flatMap((e) =>
    Object.keys(e.constraints ?? {}),
  );
}

describe('RequestOtpDto', () => {
  it('acepta un teléfono peruano y tipo válidos', () => {
    expect(errorsOf(RequestOtpDto, { phone: '+51987654321', type: 'PASSENGER' })).toHaveLength(0);
  });
  it('rechaza teléfono inválido y tipo no permitido', () => {
    const errs = errorsOf(RequestOtpDto, { phone: '123', type: 'ADMIN' });
    expect(errs).toContain('matches');
    expect(errs).toContain('isIn');
  });
});

describe('VerifyOtpDto', () => {
  it('exige OTP de 6 dígitos', () => {
    expect(errorsOf(VerifyOtpDto, { phone: '987654321', code: '12', type: 'PASSENGER' })).toContain(
      'isLength',
    );
  });
});

describe('CreateTripDto', () => {
  it('acepta origen/destino y método de pago válidos', () => {
    const errs = errorsOf(CreateTripDto, {
      origin: { lat: -12.04, lon: -77.04 },
      destination: { lat: -12.1, lon: -77.0 },
      paymentMethod: 'CASH',
    });
    expect(errs).toHaveLength(0);
  });
  it('rechaza método de pago desconocido', () => {
    const errs = errorsOf(CreateTripDto, {
      origin: { lat: -12.04, lon: -77.04 },
      destination: { lat: -12.1, lon: -77.0 },
      paymentMethod: 'BITCOIN',
    });
    expect(errs).toContain('isEnum');
  });
  it('rechaza código de modo niño no numérico', () => {
    const errs = errorsOf(CreateTripDto, {
      origin: { lat: -12.04, lon: -77.04 },
      destination: { lat: -12.1, lon: -77.0 },
      paymentMethod: 'CASH',
      childMode: true,
      childCode: 'abc',
    });
    expect(errs).toContain('matches');
  });
});
