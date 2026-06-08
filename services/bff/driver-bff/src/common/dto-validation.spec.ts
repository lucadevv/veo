import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { VerifyOtpDto } from '../auth/dto/auth.dto';
import { SurgeQueryDto } from '../dispatch/dto/dispatch.dto';
import { OnboardDto } from '../drivers/dto/drivers.dto';
import { StartTripDto } from '../trips/dto/trips.dto';

function errorsFor<T extends object>(cls: new () => T, payload: unknown): string[] {
  const instance = plainToInstance(cls, payload, { enableImplicitConversion: false });
  return validateSync(instance as object).flatMap((e) => Object.keys(e.constraints ?? {}));
}

describe('Validación de DTOs', () => {
  it('VerifyOtpDto acepta teléfono y código válidos', () => {
    expect(errorsFor(VerifyOtpDto, { phone: '+51987654321', code: '123456' })).toEqual([]);
  });

  it('VerifyOtpDto rechaza código no numérico y teléfono inválido', () => {
    const errs = errorsFor(VerifyOtpDto, { phone: 'abc', code: '12' });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('SurgeQueryDto convierte strings de query a number y valida rangos', () => {
    expect(errorsFor(SurgeQueryDto, { lat: '-12.0464', lon: '-77.0428' })).toEqual([]);
    expect(errorsFor(SurgeQueryDto, { lat: '999', lon: '0' }).length).toBeGreaterThan(0);
  });

  it('OnboardDto exige fecha ISO-8601 de vencimiento', () => {
    expect(errorsFor(OnboardDto, { licenseNumber: 'A1-123', licenseExpiresAt: '2027-01-01' })).toEqual([]);
    expect(
      errorsFor(OnboardDto, { licenseNumber: 'A1-123', licenseExpiresAt: 'no-fecha' }).length,
    ).toBeGreaterThan(0);
  });

  it('StartTripDto valida el formato del código de modo niño', () => {
    expect(errorsFor(StartTripDto, {})).toEqual([]);
    expect(errorsFor(StartTripDto, { childCode: '1234' })).toEqual([]);
    expect(errorsFor(StartTripDto, { childCode: 'abcd' }).length).toBeGreaterThan(0);
  });
});
