/**
 * Pricing (F2.4 tarifa base + ADR 010 §9.3 piso de la PUJA) — proxy a trip-service + RBAC + validación de DTO.
 *  - PricingService: GET/PUT proxy a trip-service (mock del InternalRestClient); el PUT audita.
 *  - RBAC: FINANCE/ADMIN permitidos (pricing:manage); SUPPORT_L1 → ForbiddenError (no pricing:*).
 *  - DTO: rechaza montos fuera de cota (defensa en profundidad; trip-service re-valida).
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
import { AdminRole } from '@veo/shared-types';
import type { InternalRestClient } from '@veo/rpc';
import { PricingService } from './pricing.service';
import type { AuditRecorder } from '../audit/audit-recorder.service';
import { ReplaceBaseFareDto } from './dto/pricing.dto';

const admin: AuthenticatedUser = {
  userId: 'a1',
  type: 'admin',
  roles: [AdminRole.ADMIN],
  sessionId: 's1',
};

describe('PricingService · proxy a trip-service', () => {
  it('F2.4 · GET base-fare → proxya con la identidad admin, sin auditar', async () => {
    const baseFare = {
      baseFareCents: 600,
      perKmCents: 120,
      perMinCents: 30,
      version: 1,
      updatedAt: '2026-06-27T00:00:00.000Z',
    };
    const rest = { get: vi.fn().mockResolvedValue(baseFare), put: vi.fn() };
    const audit = { record: vi.fn() };
    const svc = new PricingService(
      rest as unknown as InternalRestClient,
      audit as unknown as AuditRecorder,
    );

    const out = await svc.getBaseFare(admin);

    expect(out).toBe(baseFare);
    expect(rest.get).toHaveBeenCalledWith('/internal/pricing/base-fare', { identity: admin });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('F2.4 · PUT base-fare → proxya los tres componentes y audita la mutación', async () => {
    const baseFare = {
      baseFareCents: 800,
      perKmCents: 150,
      perMinCents: 40,
      version: 2,
      updatedAt: '2026-06-27T00:00:00.000Z',
    };
    const rest = { get: vi.fn(), put: vi.fn().mockResolvedValue(baseFare) };
    const audit = { record: vi.fn().mockResolvedValue({ id: 'x', seq: '1', hash: 'h' }) };
    const svc = new PricingService(
      rest as unknown as InternalRestClient,
      audit as unknown as AuditRecorder,
    );

    const out = await svc.replaceBaseFare(admin, {
      baseFareCents: 800,
      perKmCents: 150,
      perMinCents: 40,
      expectedVersion: 1,
    });

    expect(out).toBe(baseFare);
    expect(rest.put).toHaveBeenCalledWith('/internal/pricing/base-fare', {
      identity: admin,
      body: { baseFareCents: 800, perKmCents: 150, perMinCents: 40, expectedVersion: 1 },
    });
    expect(audit.record).toHaveBeenCalledWith(admin, {
      action: 'pricing.base_fare_replace',
      resourceType: 'base_fare_config',
      resourceId: '2',
      payload: { baseFareCents: 800, perKmCents: 150, perMinCents: 40, version: 2 },
    });
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

describe('Pricing RBAC · pricing:manage (PUT base-fare / bid-floor)', () => {
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
  it('F2.4 · ReplaceBaseFareDto: acepta los tres componentes válidos, rechaza negativo / > techo / no-entero', async () => {
    expect(
      await errorsOf(ReplaceBaseFareDto, {
        baseFareCents: 600,
        perKmCents: 120,
        perMinCents: 30,
        expectedVersion: 1,
      }),
    ).toEqual([]);
    expect(
      await errorsOf(ReplaceBaseFareDto, {
        baseFareCents: 0,
        perKmCents: 0,
        perMinCents: 0,
        expectedVersion: 0,
      }),
    ).toEqual([]);
    expect(
      await errorsOf(ReplaceBaseFareDto, {
        baseFareCents: -1,
        perKmCents: 120,
        perMinCents: 30,
        expectedVersion: 0,
      }),
    ).toContain('baseFareCents');
    expect(
      await errorsOf(ReplaceBaseFareDto, {
        baseFareCents: 600,
        perKmCents: 5001,
        perMinCents: 30,
        expectedVersion: 0,
      }),
    ).toContain('perKmCents');
    expect(
      await errorsOf(ReplaceBaseFareDto, {
        baseFareCents: 600,
        perKmCents: 120,
        perMinCents: 12.5,
        expectedVersion: 0,
      }),
    ).toContain('perMinCents');
    expect(
      await errorsOf(ReplaceBaseFareDto, {
        baseFareCents: 600,
        perKmCents: 120,
        perMinCents: 30,
        expectedVersion: -1,
      }),
    ).toContain('expectedVersion');
  });
});
