import { describe, expect, it } from 'vitest';
import type { StyleSpecification } from 'maplibre-gl';
import { resolveMapStyle } from './map-style';

/** Type guard: el resultado es un StyleSpecification objeto (no string ni null). */
function asStyleObject(result: string | StyleSpecification | null): StyleSpecification {
  expect(result).not.toBeNull();
  expect(typeof result).toBe('object');
  return result as StyleSpecification;
}

describe('resolveMapStyle', () => {
  it('devuelve null cuando no hay tiles configurados', () => {
    expect(resolveMapStyle('')).toBeNull();
    expect(resolveMapStyle('   ')).toBeNull();
  });

  it('usa la URL directa de un style.json sin envolver ni aplicar paint', () => {
    const url = 'https://tiles.veo.pe/styles/veo/style.json';
    expect(resolveMapStyle(url)).toBe(url);
  });

  it('recorta espacios alrededor de la URL del style.json', () => {
    const url = 'https://tiles.veo.pe/styles/veo/style.json';
    expect(resolveMapStyle(`  ${url}  `)).toBe(url);
  });

  it('construye un style raster mínimo para una plantilla XYZ', () => {
    const style = asStyleObject(resolveMapStyle('https://tiles.veo.pe/{z}/{x}/{y}.png'));
    expect(style.version).toBe(8);
    expect(style.sources['osm-tiles']).toMatchObject({ type: 'raster', tileSize: 256 });
    expect(style.layers).toHaveLength(1);
    expect(style.layers[0]).toMatchObject({ id: 'osm-tiles', type: 'raster' });
  });

  it('atenúa el raster XYZ vía paint para el lienzo claro Trust (claro y desaturado)', () => {
    const style = asStyleObject(resolveMapStyle('https://tiles.veo.pe/{z}/{x}/{y}.png'));
    const [layer] = style.layers;
    // El paint del raster desatura el OSM crudo para que la ruta teal de marca resalte encima.
    // Narrowing por el discriminante `type` para tipar el paint como raster sin usar `any`.
    if (layer?.type !== 'raster') {
      throw new Error('La primera capa debe ser de tipo raster');
    }
    const { paint } = layer;
    expect(paint).toBeDefined();
    // Tile CLARO (identidad Trust): el blanco del OSM se conserva, no se oscurece.
    expect(paint?.['raster-brightness-max']).toBe(1);
    // Negros del tile apenas levantados hacia el gris de la identidad (labels aún legibles).
    expect(paint?.['raster-brightness-min']).toBeGreaterThan(0);
    expect(paint?.['raster-brightness-min']).toBeLessThan(0.15);
    // Desaturado: el OSM colorido no compite con el teal de marca.
    expect(paint?.['raster-saturation']).toBeLessThan(0);
    expect(paint?.['raster-contrast']).toBeLessThanOrEqual(0);
  });
});
