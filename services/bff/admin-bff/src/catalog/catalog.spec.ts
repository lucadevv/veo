/**
 * Catalog (ADR 013 · admin-bff) — proxy del overlay del catálogo + RBAC + validación de DTO.
 *  - CatalogService: GET/PUT proxy a trip-service (mock del InternalRestClient); el PUT audita.
 *  - RBAC: ADMIN/SUPERADMIN/FINANCE permitidos (catalog:manage); SUPPORT_L1 → ForbiddenError.
 *  - DTO: rechaza id fuera del catálogo, enabled no-boolean y ids duplicados (defensa en profundidad;
 *    trip-service re-valida).
 */
import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RolesGuard, type AuthenticatedUser } from '@veo/auth';
import { ForbiddenError } from '@veo/utils';
import { AdminRole, OfferingId, PricingMode, resolveCatalog } from '@veo/shared-types';
import type { InternalRestClient } from '@veo/rpc';
import { CatalogService, type CatalogView } from './catalog.service';
import type { AuditRecorder } from '../audit/audit-recorder.service';
import { ReplaceCatalogDto } from './dto/catalog.dto';

const admin: AuthenticatedUser = {
  userId: 'a1',
  type: 'admin',
  roles: [AdminRole.ADMIN],
  sessionId: 's1',
};

// offerings = catálogo base REAL (ResolvedOffering[] de @veo/shared-types) — el mismo tipo que trip-service
// produce y admin-bff ahora comparte. El test solo valida el proxy (toBe(view)), no inspecciona campos.
const view: CatalogView = {
  version: 3,
  updatedAt: '2026-06-15T10:00:00.000Z',
  offerings: [...resolveCatalog(null)],
  overrides: [{ id: OfferingId.VEO_MOTO, enabled: false }],
};

describe('CatalogService · proxy a trip-service', () => {
  it('GET /catalog → proxya con la identidad admin firmada, sin auditar', async () => {
    const rest = { get: vi.fn().mockResolvedValue(view), put: vi.fn() };
    const audit = { record: vi.fn() };
    const svc = new CatalogService(
      rest as unknown as InternalRestClient,
      audit as unknown as AuditRecorder,
    );

    const out = await svc.getCatalog(admin);

    expect(out).toBe(view);
    expect(rest.get).toHaveBeenCalledWith('/internal/catalog', { identity: admin });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('PUT /catalog → proxya el overlay y audita la mutación', async () => {
    const rest = { get: vi.fn(), put: vi.fn().mockResolvedValue(view) };
    const audit = { record: vi.fn().mockResolvedValue({ id: 'x', seq: '1', hash: 'h' }) };
    const svc = new CatalogService(
      rest as unknown as InternalRestClient,
      audit as unknown as AuditRecorder,
    );

    const dto: ReplaceCatalogDto = {
      overrides: [{ id: OfferingId.VEO_MOTO, enabled: false }],
      expectedVersion: 2,
    };
    const out = await svc.replaceCatalog(admin, dto);

    expect(out).toBe(view);
    expect(rest.put).toHaveBeenCalledWith('/internal/catalog', {
      identity: admin,
      body: { overrides: dto.overrides, expectedVersion: 2 },
    });
    expect(audit.record).toHaveBeenCalledWith(admin, {
      action: 'catalog.overlay_replace',
      resourceType: 'offering_catalog',
      resourceId: '3',
      payload: { overrideCount: 1, version: 3 },
    });
  });

  it('fail-closed: si el audit falla, replaceCatalog falla', async () => {
    const rest = { get: vi.fn(), put: vi.fn().mockResolvedValue(view) };
    const audit = { record: vi.fn().mockRejectedValue(new Error('audit down')) };
    const svc = new CatalogService(
      rest as unknown as InternalRestClient,
      audit as unknown as AuditRecorder,
    );

    await expect(svc.replaceCatalog(admin, { overrides: [], expectedVersion: 0 })).rejects.toThrow(
      'audit down',
    );
  });
});

// ── RBAC (catalog:manage = ADMIN/SUPERADMIN/FINANCE) ──
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

describe('Catalog RBAC · catalog:manage (PUT /catalog)', () => {
  it('ADMIN → permitido', () => {
    const guard = new RolesGuard(reflectorReturning(MANAGE));
    expect(guard.canActivate(ctxWithUser(admin))).toBe(true);
  });

  it('SUPPORT_L1 → 403 ForbiddenError', () => {
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

describe('Catalog DTO · validación', () => {
  it('ReplaceCatalogDto válido → sin errores', async () => {
    const ok = {
      overrides: [
        { id: OfferingId.VEO_MOTO, enabled: false },
        { id: OfferingId.VEO_XL, enabled: true },
      ],
      expectedVersion: 0,
    };
    expect(await errorsOf(ReplaceCatalogDto, ok)).toEqual([]);
  });

  it('rechaza un id fuera del catálogo', async () => {
    expect(
      await errorsOf(ReplaceCatalogDto, { overrides: [{ id: 'veo_fantasma', enabled: true }] }),
    ).toContain('overrides');
  });

  it('rechaza enabled no-boolean', async () => {
    expect(
      await errorsOf(ReplaceCatalogDto, {
        overrides: [{ id: OfferingId.VEO_MOTO, enabled: 'sí' }],
      }),
    ).toContain('overrides');
  });

  it('rechaza ids DUPLICADOS (@ArrayUnique)', async () => {
    const dup = {
      overrides: [
        { id: OfferingId.VEO_MOTO, enabled: true },
        { id: OfferingId.VEO_MOTO, enabled: false },
      ],
    };
    expect(await errorsOf(ReplaceCatalogDto, dup)).toContain('overrides');
  });

  it('B2 · acepta mode/multiplier/minFareCents válidos', async () => {
    const ok = {
      overrides: [
        {
          id: OfferingId.VEO_ECONOMICO,
          enabled: true,
          mode: PricingMode.FIXED,
          multiplier: 1.5,
          minFareCents: 700,
        },
      ],
      expectedVersion: 0,
    };
    expect(await errorsOf(ReplaceCatalogDto, ok)).toEqual([]);
  });

  it('ADR 023 §3 · acepta los params por-servicio válidos (base/km/min, incl. 0)', async () => {
    const ok = {
      overrides: [
        {
          id: OfferingId.VEO_MECHANIC,
          enabled: true,
          baseFareCents: 2500,
          // 0 es válido (call-out plano no cobra distancia/tiempo): @Min(0) lo acepta.
          perKmCents: 0,
          perMinCents: 0,
        },
      ],
      expectedVersion: 0,
    };
    expect(await errorsOf(ReplaceCatalogDto, ok)).toEqual([]);
  });

  it('B2 · rechaza mode inválido / multiplier ≤ 0 / minFareCents negativo', async () => {
    const badMode = { overrides: [{ id: OfferingId.VEO_MOTO, enabled: true, mode: 'REGATEO' }] };
    expect(await errorsOf(ReplaceCatalogDto, badMode)).toContain('overrides');
    const badMult = { overrides: [{ id: OfferingId.VEO_MOTO, enabled: true, multiplier: 0 }] };
    expect(await errorsOf(ReplaceCatalogDto, badMult)).toContain('overrides');
    const badMin = { overrides: [{ id: OfferingId.VEO_MOTO, enabled: true, minFareCents: -100 }] };
    expect(await errorsOf(ReplaceCatalogDto, badMin)).toContain('overrides');
    // hardening: minFareCents por encima del techo de cordura (S/1000 = 100000 céntimos) → rechazado.
    const tooHighMin = {
      overrides: [{ id: OfferingId.VEO_MOTO, enabled: true, minFareCents: 200_000 }],
      expectedVersion: 0,
    };
    expect(await errorsOf(ReplaceCatalogDto, tooHighMin)).toContain('overrides');
  });

  it('ADR 023 §3 · rechaza params por-servicio negativos o sobre el techo de cordura', async () => {
    const badBase = { overrides: [{ id: OfferingId.VEO_MOTO, enabled: true, baseFareCents: -1 }] };
    expect(await errorsOf(ReplaceCatalogDto, badBase)).toContain('overrides');
    const badKm = { overrides: [{ id: OfferingId.VEO_MOTO, enabled: true, perKmCents: -1 }] };
    expect(await errorsOf(ReplaceCatalogDto, badKm)).toContain('overrides');
    // per-min por encima del techo (S/20 = 2000 céntimos) → rechazado (dedazo del admin).
    const tooHighMin = {
      overrides: [{ id: OfferingId.VEO_MOTO, enabled: true, perMinCents: 9_999 }],
      expectedVersion: 0,
    };
    expect(await errorsOf(ReplaceCatalogDto, tooHighMin)).toContain('overrides');
  });
});
