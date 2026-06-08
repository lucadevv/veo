/**
 * Pricing (ADR 011 §6 · M3) — proxy del schedule de modo + RBAC + validación de DTO.
 *  - PricingService: GET/PUT proxy a trip-service (mock del InternalRestClient); el PUT audita.
 *  - RBAC: FINANCE/ADMIN permitidos (pricing:manage); SUPPORT_L1 → ForbiddenError (no pricing:*).
 *  - DTO: rechaza dayMask/minute/mode fuera de cota (defensa en profundidad; trip-service re-valida).
 *  - Identidad: el BFF propaga la identidad type==='admin' tal cual al rest client → trip-service la firma
 *    HMAC y su AdminIdentityGuard la acepta.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RolesGuard, type AuthenticatedUser } from '@veo/auth';
import { ForbiddenError } from '@veo/utils';
import { AdminRole, PricingMode } from '@veo/shared-types';
import type { InternalRestClient } from '@veo/rpc';
import { PricingService, type ModeScheduleView } from './pricing.service';
import type { AuditRecorder } from '../audit/audit-recorder.service';
import { ReplaceScheduleDto, PricingModeRuleDto } from './dto/pricing.dto';

const admin: AuthenticatedUser = { userId: 'a1', type: 'admin', roles: [AdminRole.ADMIN], sessionId: 's1' };

const schedule: ModeScheduleView = {
  version: 7,
  defaultMode: PricingMode.PUJA,
  rules: [{ dayMask: 31, startMinute: 420, endMinute: 540, mode: PricingMode.FIXED }],
  updatedAt: '2026-06-04T10:00:00.000Z',
};

describe('PricingService · proxy a trip-service', () => {
  it('GET mode-schedule → proxya al rest client con la identidad admin firmada', async () => {
    const rest = { get: vi.fn().mockResolvedValue(schedule), put: vi.fn() };
    const audit = { record: vi.fn() };
    const svc = new PricingService(rest as unknown as InternalRestClient, audit as unknown as AuditRecorder);

    const out = await svc.getSchedule(admin);

    expect(out).toBe(schedule);
    expect(rest.get).toHaveBeenCalledWith('/internal/pricing/mode-schedule', { identity: admin });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('PUT mode-schedule → proxya el body completo y audita la mutación', async () => {
    const rest = { get: vi.fn(), put: vi.fn().mockResolvedValue(schedule) };
    const audit = { record: vi.fn().mockResolvedValue({ id: 'x', seq: '1', hash: 'h' }) };
    const svc = new PricingService(rest as unknown as InternalRestClient, audit as unknown as AuditRecorder);

    const dto: ReplaceScheduleDto = {
      defaultMode: PricingMode.PUJA,
      rules: [{ dayMask: 31, startMinute: 420, endMinute: 540, mode: PricingMode.FIXED }],
    };
    const out = await svc.replaceSchedule(admin, dto);

    expect(out).toBe(schedule);
    expect(rest.put).toHaveBeenCalledWith('/internal/pricing/mode-schedule', {
      identity: admin,
      body: { defaultMode: PricingMode.PUJA, rules: dto.rules },
    });
    expect(audit.record).toHaveBeenCalledWith(admin, {
      action: 'pricing.mode_schedule_replace',
      resourceType: 'pricing_mode_schedule',
      resourceId: '7',
      payload: { defaultMode: PricingMode.PUJA, ruleCount: 1, version: 7 },
    });
  });

  it('fail-closed: si el audit falla, replaceSchedule falla', async () => {
    const rest = { get: vi.fn(), put: vi.fn().mockResolvedValue(schedule) };
    const audit = { record: vi.fn().mockRejectedValue(new Error('audit down')) };
    const svc = new PricingService(rest as unknown as InternalRestClient, audit as unknown as AuditRecorder);

    await expect(
      svc.replaceSchedule(admin, { defaultMode: PricingMode.PUJA, rules: [] }),
    ).rejects.toThrow('audit down');
  });
});

// ── RBAC (pricing:manage = ADMIN/SUPERADMIN/FINANCE) ──
function reflectorReturning(value: unknown): Reflector {
  return { getAllAndOverride: () => value } as unknown as Reflector;
}
function ctxWithUser(user?: AuthenticatedUser): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

const MANAGE = [AdminRole.ADMIN, AdminRole.SUPERADMIN, AdminRole.FINANCE];

describe('Pricing RBAC · pricing:manage (PUT mode-schedule)', () => {
  it('FINANCE → permitido', () => {
    const guard = new RolesGuard(reflectorReturning(MANAGE));
    const finance: AuthenticatedUser = { ...admin, roles: [AdminRole.FINANCE] };
    expect(guard.canActivate(ctxWithUser(finance))).toBe(true);
  });

  it('ADMIN → permitido', () => {
    const guard = new RolesGuard(reflectorReturning(MANAGE));
    expect(guard.canActivate(ctxWithUser(admin))).toBe(true);
  });

  it('SUPPORT_L1 (sin pricing:*) → 403 ForbiddenError', () => {
    const guard = new RolesGuard(reflectorReturning(MANAGE));
    const support: AuthenticatedUser = { ...admin, roles: [AdminRole.SUPPORT_L1] };
    expect(() => guard.canActivate(ctxWithUser(support))).toThrow(ForbiddenError);
  });
});

// ── DTO validation (defensa en profundidad) ──
async function errorsOf<T extends object>(cls: new () => T, payload: unknown): Promise<string[]> {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance as object);
  return errors.map((e) => e.property);
}

describe('Pricing DTO · validación', () => {
  it('ReplaceScheduleDto válido → sin errores', async () => {
    const ok = {
      defaultMode: PricingMode.PUJA,
      rules: [{ dayMask: 31, startMinute: 420, endMinute: 540, mode: PricingMode.FIXED }],
    };
    expect(await errorsOf(ReplaceScheduleDto, ok)).toEqual([]);
  });

  it('rechaza defaultMode fuera del enum', async () => {
    expect(await errorsOf(ReplaceScheduleDto, { defaultMode: 'SURGE', rules: [] })).toContain('defaultMode');
  });

  it('PricingModeRuleDto: rechaza dayMask=0 / dayMask=128 (rango 1..127)', async () => {
    expect(await errorsOf(PricingModeRuleDto, { dayMask: 0, startMinute: 0, endMinute: 1, mode: PricingMode.PUJA })).toContain('dayMask');
    expect(await errorsOf(PricingModeRuleDto, { dayMask: 128, startMinute: 0, endMinute: 1, mode: PricingMode.PUJA })).toContain('dayMask');
  });

  it('PricingModeRuleDto: rechaza minute=1440 (rango 0..1439)', async () => {
    const errs = await errorsOf(PricingModeRuleDto, { dayMask: 1, startMinute: 1440, endMinute: 2000, mode: PricingMode.PUJA });
    expect(errs).toEqual(expect.arrayContaining(['startMinute', 'endMinute']));
  });

  it('PricingModeRuleDto: rechaza mode fuera del enum', async () => {
    expect(await errorsOf(PricingModeRuleDto, { dayMask: 1, startMinute: 0, endMinute: 1, mode: 'SURGE' })).toContain('mode');
  });

  // S5 (M5) — cross-field: una regla overnight (start >= end) quedaría inerte en el resolver → 400 claro.
  it('S5: rechaza startMinute >= endMinute (regla overnight inerte) con mensaje claro', async () => {
    const instance = plainToInstance(PricingModeRuleDto, {
      dayMask: 127,
      startMinute: 1320, // 22:00
      endMinute: 360, // 06:00 (del MISMO día → end <= start)
      mode: PricingMode.FIXED,
    });
    const errors = await validate(instance as object);
    const endErr = errors.find((e) => e.property === 'endMinute');
    expect(endErr).toBeTruthy();
    const msg = Object.values(endErr?.constraints ?? {}).join(' ');
    expect(msg).toContain('una regla no puede terminar antes o cuando empieza');
    expect(msg).toContain('22:00-24:00');
  });

  it('S5: rechaza startMinute === endMinute (rango vacío)', async () => {
    expect(
      await errorsOf(PricingModeRuleDto, { dayMask: 1, startMinute: 600, endMinute: 600, mode: PricingMode.FIXED }),
    ).toContain('endMinute');
  });

  it('S5: una regla same-day válida (start < end) pasa', async () => {
    expect(
      await errorsOf(PricingModeRuleDto, { dayMask: 127, startMinute: 1320, endMinute: 1439, mode: PricingMode.FIXED }),
    ).toEqual([]);
  });
});
