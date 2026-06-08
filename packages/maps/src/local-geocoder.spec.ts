import { describe, it, expect } from 'vitest';
import { LocalMapsEngine } from './local-engine.js';
import { LimaGeocoder, normalizeText } from './local-geocoder.js';
import { LIMA_PLACES } from './data/lima-places.js';

const MIRAFLORES = { lat: -12.1211, lon: -77.0297 };
const SURCO = { lat: -12.1453, lon: -76.9947 };
const CALLAO = { lat: -12.0566, lon: -77.1181 };

describe('normalizeText', () => {
  it('quita tildes y baja a minúsculas', () => {
    expect(normalizeText('Jesús María')).toBe('jesus maria');
    expect(normalizeText('AEROPUERTO Jorge Chávez')).toBe('aeropuerto jorge chavez');
  });

  it('colapsa signos y espacios', () => {
    expect(normalizeText('  Óvalo   Gutiérrez!! ')).toBe('ovalo gutierrez');
  });
});

describe('LimaGeocoder', () => {
  const geo = new LimaGeocoder();

  it('geocode("jockey") devuelve Jockey Plaza', () => {
    const r = geo.geocode('jockey');
    expect(r?.name).toBe('Jockey Plaza');
    expect(r?.displayName).toContain('Santiago de Surco');
  });

  it('autocomplete("jockey") trae Jockey Plaza primero', () => {
    const results = geo.autocomplete('jockey');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.name).toBe('Jockey Plaza');
  });

  it('autocomplete sin tildes matchea con tildes ("miraflores")', () => {
    const results = geo.autocomplete('miraflores');
    expect(results.some((r) => r.name === 'Miraflores')).toBe(true);
  });

  it('autocomplete("aeropuerto") resuelve Jorge Chávez vía alias', () => {
    const results = geo.autocomplete('aeropuerto');
    expect(results[0]?.name).toContain('Jorge Chávez');
  });

  it('autocomplete sesga por proximidad: misma query, distinto near → distinto orden', () => {
    // "universidad" matchea varias; cerca de San Miguel debe priorizar PUCP/UNMSM sobre ULima (Surco).
    const nearSanMiguel = { lat: -12.0772, lon: -77.0922 };
    const cerca = geo.autocomplete('universidad', nearSanMiguel);
    const lejos = geo.autocomplete('universidad', SURCO);
    expect(cerca[0]?.name).not.toBe(lejos[0]?.name);
    // El primero cerca de San Miguel está más cerca de San Miguel que el primero sesgado a Surco.
    const dist = (p: { lat: number; lon: number }, q: { lat: number; lon: number }) =>
      Math.hypot(p.lat - q.lat, p.lon - q.lon);
    expect(dist(cerca[0]!, nearSanMiguel)).toBeLessThan(dist(lejos[0]!, nearSanMiguel));
  });

  it('autocomplete respeta el límite', () => {
    expect(geo.autocomplete('a', undefined, 3).length).toBeLessThanOrEqual(3);
  });

  it('reverse cerca de Miraflores devuelve algo de Miraflores', () => {
    const r = geo.reverse({ lat: -12.1215, lon: -77.03 });
    expect(r?.displayName).toContain('Miraflores');
  });

  it('reverse en el Callao devuelve un lugar del Callao', () => {
    const r = geo.reverse(CALLAO);
    expect(r?.displayName).toContain('Callao');
  });

  it('es determinista: misma query/near → mismo resultado', () => {
    expect(geo.autocomplete('plaza', MIRAFLORES)).toEqual(geo.autocomplete('plaza', MIRAFLORES));
  });

  it('query sin match devuelve [] / null', () => {
    expect(geo.autocomplete('zzzqwerty')).toEqual([]);
    expect(geo.geocode('zzzqwerty')).toBeNull();
  });

  it('el dataset tiene un volumen razonable de lugares', () => {
    expect(LIMA_PLACES.length).toBeGreaterThanOrEqual(60);
  });
});

describe('LocalMapsEngine geocoding', () => {
  const engine = new LocalMapsEngine();

  it('autocomplete corta queries < 3 caracteres', async () => {
    expect(await engine.autocomplete('ab')).toEqual([]);
  });

  it('autocomplete("miraflores") sesgado a Surco devuelve resultados', async () => {
    const results = await engine.autocomplete('miraflores', { near: SURCO });
    expect(results.length).toBeGreaterThan(0);
  });

  it('geocode delega en el dataset', async () => {
    const r = await engine.geocode('larcomar');
    expect(r?.name).toBe('Larcomar');
  });

  it('reverse delega en el dataset (más cercano)', async () => {
    const r = await engine.reverse(MIRAFLORES);
    expect(r).not.toBeNull();
    expect(r?.displayName).toContain('Lima');
  });
});
