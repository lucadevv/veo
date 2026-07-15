import { describe, it, expect } from 'vitest';
import { REGIONS_PE, regionById, regionForPoint, regionForLatLon } from './regions.js';
import { LIMA_BBOX } from './geo.js';

/**
 * Catálogo de regiones del BROWSE de carpool: contención de puntos ANCLA conocidos (ciudades reales),
 * solapamiento resuelto por MENOR ÁREA (región más específica gana) y el undefined honesto fuera de todo
 * bbox (mar). Los ids son contrato de wire: el test los fija para cazar un rename accidental.
 */
describe('REGIONS_PE · catálogo', () => {
  it('los ids de wire son estables (kebab-case, contrato con los clientes)', () => {
    expect(REGIONS_PE.map((r) => r.id)).toEqual([
      'lima-metropolitana',
      'arequipa',
      'cusco',
      'la-libertad',
      'piura',
      'ica',
      'junin',
      'lambayeque',
      'ancash',
    ]);
  });

  it('todos los bbox son envolventes bien formadas (min < max en ambos ejes)', () => {
    for (const { bbox } of REGIONS_PE) {
      expect(bbox.minLat).toBeLessThan(bbox.maxLat);
      expect(bbox.minLon).toBeLessThan(bbox.maxLon);
    }
  });

  it('lima-metropolitana reusa LIMA_BBOX (una sola fuente para "Lima urbana", BR-D03)', () => {
    expect(regionById('lima-metropolitana')?.bbox).toEqual(LIMA_BBOX);
  });

  it('regionById: id conocido → la región; desconocido → undefined (el borde lo vuelve 400)', () => {
    expect(regionById('arequipa')?.nombre).toBe('Arequipa');
    expect(regionById('narnia')).toBeUndefined();
    expect(regionById('Lima-Metropolitana')).toBeUndefined(); // case-sensitive: el id de wire es exacto
  });
});

describe('regionForPoint · contención con puntos ancla reales', () => {
  it('Lima centro (Plaza de Armas) → lima-metropolitana', () => {
    expect(regionForPoint(-12.0464, -77.0428)?.id).toBe('lima-metropolitana');
  });

  it('Huaraz (sierra) y Chimbote (costa) → ancash', () => {
    expect(regionForPoint(-9.53, -77.53)?.id).toBe('ancash');
    expect(regionForPoint(-9.07, -78.59)?.id).toBe('ancash');
  });

  it('Arequipa ciudad → arequipa; Cusco ciudad → cusco', () => {
    expect(regionForPoint(-16.41, -71.54)?.id).toBe('arequipa');
    expect(regionForPoint(-13.53, -71.97)?.id).toBe('cusco');
  });

  it('Trujillo → la-libertad; Chiclayo → lambayeque; Piura ciudad → piura; Huancayo → junin; Ica ciudad → ica', () => {
    expect(regionForPoint(-8.11, -79.03)?.id).toBe('la-libertad');
    expect(regionForPoint(-6.77, -79.84)?.id).toBe('lambayeque');
    expect(regionForPoint(-5.19, -80.63)?.id).toBe('piura');
    expect(regionForPoint(-12.07, -75.21)?.id).toBe('junin');
    expect(regionForPoint(-14.07, -75.73)?.id).toBe('ica');
  });

  it('punto en el mar (frente a la costa) → undefined honesto', () => {
    expect(regionForPoint(-12.0, -78.5)).toBeUndefined();
  });

  it('punto fuera de Perú → undefined', () => {
    expect(regionForPoint(40.4168, -3.7038)).toBeUndefined(); // Madrid
  });

  it('el azúcar regionForLatLon delega en regionForPoint (mismo resultado)', () => {
    expect(regionForLatLon({ lat: -12.0464, lon: -77.0428 })?.id).toBe('lima-metropolitana');
  });
});

describe('regionForPoint · solapamiento resuelto por MENOR ÁREA (región más específica)', () => {
  it('esquina Ica ∩ Arequipa: el punto cae en ambos bbox y gana ica (envolvente menor)', () => {
    const lat = -15.0;
    const lon = -74.9;
    // Precondición del test: el punto REALMENTE cae en ambos bbox (si un bbox cambia, esto lo delata).
    const containing = REGIONS_PE.filter(
      (r) =>
        lat >= r.bbox.minLat && lat <= r.bbox.maxLat && lon >= r.bbox.minLon && lon <= r.bbox.maxLon,
    ).map((r) => r.id);
    expect(containing).toEqual(expect.arrayContaining(['ica', 'arequipa']));

    expect(regionForPoint(lat, lon)?.id).toBe('ica');
  });

  it('esquina Lambayeque ∩ Piura: gana lambayeque (envolvente menor)', () => {
    const lat = -5.8;
    const lon = -80.0;
    const containing = REGIONS_PE.filter(
      (r) =>
        lat >= r.bbox.minLat && lat <= r.bbox.maxLat && lon >= r.bbox.minLon && lon <= r.bbox.maxLon,
    ).map((r) => r.id);
    expect(containing).toEqual(expect.arrayContaining(['lambayeque', 'piura']));

    expect(regionForPoint(lat, lon)?.id).toBe('lambayeque');
  });
});
