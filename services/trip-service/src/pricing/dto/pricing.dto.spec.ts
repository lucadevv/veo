/**
 * S5 (ADR 011 · M5) — validación del ReplaceScheduleDto/PricingModeRuleDto de trip-service. El gate de
 * cross-field (startMinute < endMinute) vive acá Y en admin-bff (defensa en profundidad): trip-service
 * RE-VALIDA aguas abajo, así que una regla overnight inerte se rechaza aunque entre por el endpoint interno.
 */
import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PricingMode } from '@veo/shared-types';
import { ReplaceScheduleDto, PricingModeRuleDto } from './pricing.dto';

async function errorsOf<T extends object>(cls: new () => T, payload: unknown): Promise<string[]> {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance as object);
  return errors.map((e) => e.property);
}

describe('trip-service Pricing DTO · S5 cross-field (start < end)', () => {
  it('ReplaceScheduleDto válido (regla same-day) → sin errores', async () => {
    const ok = {
      defaultMode: PricingMode.PUJA,
      rules: [{ dayMask: 31, startMinute: 420, endMinute: 540, mode: PricingMode.FIXED }],
      expectedVersion: 0,
    };
    expect(await errorsOf(ReplaceScheduleDto, ok)).toEqual([]);
  });

  it('rechaza startMinute >= endMinute (overnight inerte) con mensaje claro', async () => {
    const instance = plainToInstance(PricingModeRuleDto, {
      dayMask: 127,
      startMinute: 1320, // 22:00
      endMinute: 360, // 06:00 → end <= start
      mode: PricingMode.FIXED,
    });
    const errors = await validate(instance as object);
    const endErr = errors.find((e) => e.property === 'endMinute');
    expect(endErr).toBeTruthy();
    const msg = Object.values(endErr?.constraints ?? {}).join(' ');
    expect(msg).toContain('una regla no puede terminar antes o cuando empieza');
    expect(msg).toContain('22:00-24:00');
  });

  it('rechaza startMinute === endMinute (rango vacío)', async () => {
    expect(
      await errorsOf(PricingModeRuleDto, { dayMask: 1, startMinute: 600, endMinute: 600, mode: PricingMode.FIXED }),
    ).toContain('endMinute');
  });

  it('una regla same-day válida (start < end) pasa', async () => {
    expect(
      await errorsOf(PricingModeRuleDto, { dayMask: 127, startMinute: 1320, endMinute: 1439, mode: PricingMode.FIXED }),
    ).toEqual([]);
  });
});
