/**
 * F2.1b · invariante de completitud + glue de energía autoritativa, compartidos por el boot-guard, el
 * replace() del catálogo y los 3 caminos de cotización (create/changeDestination/re-quote de parada).
 */
import { describe, expect, it } from 'vitest';
import { EnergySource, OFFERINGS, OfferingId } from '@veo/shared-types';
import { InvalidStateError } from '@veo/utils';
import {
  requiredEnergySources,
  missingRequiredSources,
  resolveAuthoritativeEnergy,
  type EnergyPriceLookup,
} from './energy-requirements';

const ECONOMICO = OFFERINGS[OfferingId.VEO_ECONOMICO]; // GASOLINE_90, rendimiento 12 km/L
const lookup = (price: number | null): EnergyPriceLookup => ({ getPriceFor: () => Promise.resolve(price) });

describe('requiredEnergySources · TODA fuente referenciada (overlay-safe)', () => {
  it('incluye GASOLINE_90 (ofertas RIDE visibles)', () => {
    expect(requiredEnergySources().has(EnergySource.GASOLINE_90)).toBe(true);
  });
  it('incluye DIESEL (ambulancia/grúa ocultas, encendibles por overlay — el flip las exige pobladas)', () => {
    expect(requiredEnergySources().has(EnergySource.DIESEL)).toBe(true);
  });
});

describe('missingRequiredSources · qué falta para el flip', () => {
  it('catálogo vacío → falta GASOLINE_90', () => {
    expect(missingRequiredSources(new Set())).toContain(EnergySource.GASOLINE_90);
  });
  it('catálogo con TODAS las fuentes referenciadas → nada falta (completo)', () => {
    expect(missingRequiredSources(new Set([...requiredEnergySources()]))).toEqual([]);
  });
  it('catálogo con solo GASOLINE_90 → falta DIESEL (la vertical oculta no quedó cubierta)', () => {
    expect(missingRequiredSources(new Set([EnergySource.GASOLINE_90]))).toContain(EnergySource.DIESEL);
  });
});

describe('resolveAuthoritativeEnergy · NUNCA cobra de menos en silencio', () => {
  it('catálogo ausente → InvalidStateError (config inválida, no 0)', async () => {
    await expect(resolveAuthoritativeEnergy(null, ECONOMICO)).rejects.toBeInstanceOf(InvalidStateError);
  });
  it('fuente sin precio (null) → InvalidStateError (no degrada a 0 como el shadow)', async () => {
    await expect(resolveAuthoritativeEnergy(lookup(null), ECONOMICO)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });
  it('fuente con precio → deriva precio ÷ rendimiento (1200 ÷ 12 = 100)', async () => {
    expect(await resolveAuthoritativeEnergy(lookup(1200), ECONOMICO)).toBe(100);
  });
});
