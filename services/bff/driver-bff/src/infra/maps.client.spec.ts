import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExternalServiceError } from '@veo/utils';
import { LocalMapsEngine, type AutocompleteOptions, type MapsClient } from '@veo/maps';
import { FallbackMapsClient } from './maps.client';

/**
 * Regresión del bug TS2554: `FallbackMapsClient` llamaba `fallback.geocode()`, `fallback.autocomplete()`
 * y `fallback.reverse()` SIN argumentos → no compilaba (`nest build`) y, de transpilarse, el fallback
 * recibía `undefined` y devolvía null/[] siempre. Estos tests lockean que la fachada REENVÍA al motor
 * local exactamente los mismos argumentos que recibió el método.
 */
describe('FallbackMapsClient · geocode/autocomplete/reverse delegan con los args originales', () => {
  const GEOCODE_QUERY = 'Jockey Plaza';
  const AUTOCOMPLETE_QUERY = 'larco';
  const REVERSE_POINT = { lat: -12.1318, lon: -77.0306 };
  const AUTOCOMPLETE_OPTS: AutocompleteOptions = { near: REVERSE_POINT, limit: 3 };
  const UPSTREAM_DOWN = () => new ExternalServiceError('nominatim down');

  /** Primario que siempre falla con error externo → fuerza el camino del fallback. */
  const failingPrimary = (): MapsClient =>
    ({
      geocode: vi.fn().mockRejectedValue(UPSTREAM_DOWN()),
      autocomplete: vi.fn().mockRejectedValue(UPSTREAM_DOWN()),
      reverse: vi.fn().mockRejectedValue(UPSTREAM_DOWN()),
    }) as unknown as MapsClient;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('geocode: reenvía la query al fallback local y resuelve un lugar real de Lima', async () => {
    const spy = vi.spyOn(LocalMapsEngine.prototype, 'geocode');
    const client = new FallbackMapsClient(failingPrimary());

    const out = await client.geocode(GEOCODE_QUERY);

    expect(spy).toHaveBeenCalledWith(GEOCODE_QUERY);
    // Sin el fix, la query se perdía → null. Con el fix, el dataset curado de Lima resuelve.
    expect(out).not.toBeNull();
    expect(out?.displayName).toContain(GEOCODE_QUERY);
  });

  it('autocomplete: reenvía query Y opciones (near/limit) al fallback local', async () => {
    const spy = vi.spyOn(LocalMapsEngine.prototype, 'autocomplete');
    const client = new FallbackMapsClient(failingPrimary());

    const out = await client.autocomplete(AUTOCOMPLETE_QUERY, AUTOCOMPLETE_OPTS);

    expect(spy).toHaveBeenCalledWith(AUTOCOMPLETE_QUERY, AUTOCOMPLETE_OPTS);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(AUTOCOMPLETE_OPTS.limit ?? Number.POSITIVE_INFINITY);
  });

  it('reverse: reenvía el punto al fallback local y devuelve el lugar más cercano', async () => {
    const spy = vi.spyOn(LocalMapsEngine.prototype, 'reverse');
    const client = new FallbackMapsClient(failingPrimary());

    const out = await client.reverse(REVERSE_POINT);

    expect(spy).toHaveBeenCalledWith(REVERSE_POINT);
    expect(out).not.toBeNull();
  });

  it('si el primario falla con un error NO externo, NO degrada: propaga', async () => {
    const boom = new Error('bug interno');
    const primary = { geocode: vi.fn().mockRejectedValue(boom) } as unknown as MapsClient;
    const spy = vi.spyOn(LocalMapsEngine.prototype, 'geocode');
    const client = new FallbackMapsClient(primary);

    await expect(client.geocode(GEOCODE_QUERY)).rejects.toThrow(boom);
    expect(spy).not.toHaveBeenCalled();
  });
});
