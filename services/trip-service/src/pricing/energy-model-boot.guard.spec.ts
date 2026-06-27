/**
 * F2.1b · boot-guard del flip de energía. Verifica el fail-fast: con el flip ON, el catálogo debe tener
 * precio para toda fuente de una oferta visible, o el arranque falla (anti cobro-de-menos del create).
 * EnergyCatalogService real sobre un repo fake en memoria (clean arch: depende del puerto).
 */
import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { EnergySource, EnergyUnit, type EnergySourcePrice } from '@veo/shared-types';
import { InvalidStateError } from '@veo/utils';
import { EnergyModelBootGuard } from './energy-model-boot.guard';
import { requiredEnergySources } from './energy-requirements';
import { EnergyCatalogService } from './energy-catalog.service';
import type {
  EnergyCatalogRepository,
  EnergyCatalogTx,
  PersistedEnergyCatalog,
} from './energy-catalog.repository';

class FakeRepo implements EnergyCatalogRepository {
  constructor(private config: PersistedEnergyCatalog | null = null) {}
  find(): Promise<PersistedEnergyCatalog | null> {
    return Promise.resolve(this.config);
  }
  runInTx<T>(fn: (tx: EnergyCatalogTx) => Promise<T>): Promise<T> {
    return fn({} as EnergyCatalogTx); // el guard nunca escribe; solo lee getPriceFor.
  }
}

/** Fuentes que el guard exige cuando el flip ON — la MISMA fuente de verdad que producción (overlay-safe). */
const requiredSources = requiredEnergySources();

/** Catálogo poblado con TODAS las fuentes requeridas (precio arbitrario > 0). */
const fullSources: EnergySourcePrice[] = [...requiredSources].map((sourceId) => ({
  sourceId,
  unit: sourceId === EnergySource.ELECTRIC ? EnergyUnit.KWH : EnergyUnit.LITER,
  pricePerUnitCents: 1640,
}));

const persisted = (sources: EnergySourcePrice[]): PersistedEnergyCatalog => ({
  sources,
  version: 1,
  updatedAt: new Date(0).toISOString(),
});

/** ConfigService mínimo: solo el flag que el guard lee. */
const cfg = (flipped: boolean) =>
  ({ get: (k: string) => (k === 'PRICING_ENERGY_MODEL_ENABLED' ? flipped : undefined) }) as unknown as ConfigService<
    Record<string, unknown>,
    true
  >;

const guardWith = (flipped: boolean, config: PersistedEnergyCatalog | null) =>
  new EnergyModelBootGuard(cfg(flipped), new EnergyCatalogService(new FakeRepo(config), 0));

describe('EnergyModelBootGuard (F2.1b · fail-fast del flip)', () => {
  it('flip OFF → no valida nada (catálogo vacío permitido, manda el fuel viejo)', async () => {
    await expect(guardWith(false, null).onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('flip ON + catálogo VACÍO → falla el arranque (InvalidStateError)', async () => {
    await expect(guardWith(true, null).onApplicationBootstrap()).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });

  it('flip ON + falta UNA fuente requerida → falla, y lista la fuente faltante', async () => {
    // Poblar todo MENOS la gasolina-90 (la fuente de las ofertas visibles principales).
    const partial = fullSources.filter((s) => s.sourceId !== EnergySource.GASOLINE_90);
    try {
      await guardWith(true, persisted(partial)).onApplicationBootstrap();
      expect.unreachable('debió fallar por la fuente faltante');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidStateError);
      expect((err as InvalidStateError).details?.missingSources).toContain(EnergySource.GASOLINE_90);
    }
  });

  it('flip ON + catálogo POBLADO con todas las fuentes requeridas → arranca OK', async () => {
    await expect(
      guardWith(true, persisted(fullSources)).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
  });
});
