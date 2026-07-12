/**
 * DispatchConfigController — delegación tipada al service + validación de los DTOs (defensa en profundidad).
 * El controller es fino: cada handler delega al service con la identidad + los args del DTO/query. La validación
 * de las cotas (policyV2 v2 + carpool expand>=base) es el guardrail server-side ANTES de tocar los servicios.
 */
import { describe, it, expect, vi } from 'vitest';
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { DispatchConfigController } from './dispatch-config.controller';
import {
  ReplaceRadiusConfigDto,
  ReplaceCarpoolConfigDto,
  DispatchRadarQueryDto,
} from './dto/dispatch-radius-config.dto';

const user = { userId: 'op-1', type: 'admin', roles: ['DISPATCHER'] } as never;

function makeController() {
  const svc = {
    getRadiusConfig: vi.fn().mockResolvedValue({}),
    replaceRadiusConfig: vi.fn().mockResolvedValue({}),
    radarPreview: vi.fn().mockResolvedValue({}),
    getCarpoolConfig: vi.fn().mockResolvedValue({}),
    replaceCarpoolConfig: vi.fn().mockResolvedValue({}),
    carpoolRadar: vi.fn().mockResolvedValue({}),
  };
  const ctrl = new DispatchConfigController(svc as never);
  return { ctrl, svc };
}

async function errorsOf<T extends object>(cls: new () => T, payload: unknown): Promise<string[]> {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance as object);
  return errors.map((e) => e.property);
}

const validV2 = {
  FIXED: {
    initialRadiusKm: 0.5,
    incrementKm: 0.3,
    maxRadiusKm: 2.0,
    targetDrivers: 5,
    offerTimeoutSec: 12,
    expandIntervalSec: 8,
  },
  PUJA: { broadcastRadiusKm: 1.5, bidWindowSec: 60 },
};
const baseRadius = { nearbyKRing: 3, matchKRing: 4, offerTimeoutMs: 12_000, bidWindowSec: 60 };

describe('DispatchConfigController — delegación', () => {
  it('radarPreview delega mode/lat/lon al service', async () => {
    const { ctrl, svc } = makeController();
    const q = plainToInstance(DispatchRadarQueryDto, { mode: 'FIXED', lat: '-12.05', lon: '-77.04' });
    await ctrl.radarPreview(user, q);
    expect(svc.radarPreview).toHaveBeenCalledWith(user, 'FIXED', -12.05, -77.04);
  });

  it('carpool: get/put/radar delegan al service', async () => {
    const { ctrl, svc } = makeController();
    await ctrl.getCarpoolConfig(user);
    await ctrl.replaceCarpoolConfig(user, { baseRadiusKm: 0.8, expandRadiusKm: 1.5 } as never);
    expect(svc.getCarpoolConfig).toHaveBeenCalledWith(user);
    expect(svc.replaceCarpoolConfig).toHaveBeenCalledWith(user, {
      baseRadiusKm: 0.8,
      expandRadiusKm: 1.5,
    });
  });
});

describe('ReplaceRadiusConfigDto — v2 anidado', () => {
  it('acepta k-rings + ventanas sin v2 (back-compat)', async () => {
    expect(await errorsOf(ReplaceRadiusConfigDto, baseRadius)).toEqual([]);
  });

  it('acepta policyVersion v2 + policyV2 válido', async () => {
    expect(
      await errorsOf(ReplaceRadiusConfigDto, {
        ...baseRadius,
        policyVersion: 'v2',
        policyV2: validV2,
      }),
    ).toEqual([]);
  });

  it('rechaza policyVersion fuera de {v1,v2}', async () => {
    expect(
      await errorsOf(ReplaceRadiusConfigDto, { ...baseRadius, policyVersion: 'v3' }),
    ).toContain('policyVersion');
  });

  it('rechaza FIXED.initialRadiusKm fuera de [0.3..2.4] (valida el nested)', async () => {
    const bad = { ...validV2, FIXED: { ...validV2.FIXED, initialRadiusKm: 5.0 } };
    expect(
      await errorsOf(ReplaceRadiusConfigDto, { ...baseRadius, policyVersion: 'v2', policyV2: bad }),
    ).toContain('policyV2');
  });

  it('rechaza FIXED.targetDrivers fuera de [1..20] y PUJA.bidWindowSec fuera de [15..300]', async () => {
    const bad = {
      FIXED: { ...validV2.FIXED, targetDrivers: 99 },
      PUJA: { ...validV2.PUJA, bidWindowSec: 5 },
    };
    expect(
      await errorsOf(ReplaceRadiusConfigDto, { ...baseRadius, policyVersion: 'v2', policyV2: bad }),
    ).toContain('policyV2');
  });
});

describe('ReplaceCarpoolConfigDto — cotas + expand>=base', () => {
  it('acepta base 0.8 / expand 1.5', async () => {
    expect(await errorsOf(ReplaceCarpoolConfigDto, { baseRadiusKm: 0.8, expandRadiusKm: 1.5 })).toEqual(
      [],
    );
  });

  it('rechaza expand < base (invariante del radio ampliado)', async () => {
    expect(
      await errorsOf(ReplaceCarpoolConfigDto, { baseRadiusKm: 1.4, expandRadiusKm: 0.5 }),
    ).toContain('expandRadiusKm');
  });

  it('rechaza baseRadiusKm > 1.5 y expandRadiusKm > 2.4', async () => {
    expect(
      await errorsOf(ReplaceCarpoolConfigDto, { baseRadiusKm: 2.0, expandRadiusKm: 3.0 }),
    ).toEqual(expect.arrayContaining(['baseRadiusKm', 'expandRadiusKm']));
  });
});
