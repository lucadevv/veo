import { describe, it, expect } from 'vitest';
// Los decoradores @Type (class-transformer) llaman Reflect.getMetadata al DECORAR las clases:
// sin este import el spec falla si le toca un worker limpio (mismo patrón que driver-bff).
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { LoginDto } from '../auth/dto/auth.dto';
import { RefundDto } from '../finance/dto/finance.dto';
import { RequestAccessDto } from '../media/dto/media.dto';
import { ResolvePanicDto } from '../security/dto/panic.dto';

async function errorsOf<T extends object>(cls: new () => T, payload: unknown): Promise<string[]> {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance as object);
  return errors.map((e) => e.property);
}

describe('Validación de DTOs', () => {
  it('LoginDto: email válido + password >= 10', async () => {
    expect(await errorsOf(LoginDto, { email: 'a@b.com', password: 'supersecret1' })).toEqual([]);
    expect(await errorsOf(LoginDto, { email: 'no-email', password: 'short' })).toEqual(
      expect.arrayContaining(['email', 'password']),
    );
  });

  it('RefundDto: amountCents >= 1 y reason no vacío', async () => {
    expect(await errorsOf(RefundDto, { amountCents: 100, reason: 'cliente' })).toEqual([]);
    expect(await errorsOf(RefundDto, { amountCents: 0, reason: '' })).toEqual(
      expect.arrayContaining(['amountCents', 'reason']),
    );
  });

  it('RequestAccessDto: reason exige > 20 caracteres', async () => {
    const ok = {
      tripId: '0b5d8f3e-1b2c-4d5e-8f90-1234567890ab',
      reason: 'Investigación de incidente reportado por pasajero',
    };
    expect(await errorsOf(RequestAccessDto, ok)).toEqual([]);
    expect(await errorsOf(RequestAccessDto, { ...ok, reason: 'corto' })).toContain('reason');
  });

  it('ResolvePanicDto: solo acepta RESOLVED|FALSE_ALARM', async () => {
    expect(await errorsOf(ResolvePanicDto, { resolution: 'RESOLVED' })).toEqual([]);
    expect(await errorsOf(ResolvePanicDto, { resolution: 'NOPE' })).toContain('resolution');
  });
});
