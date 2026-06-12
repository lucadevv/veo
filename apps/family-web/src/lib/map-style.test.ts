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

  it('oscurece y desatura el raster XYZ vía paint para coherencia con el lienzo negro', () => {
    const style = asStyleObject(resolveMapStyle('https://tiles.veo.pe/{z}/{x}/{y}.png'));
    const [layer] = style.layers;
    // El paint del raster es lo que oscurece el OSM claro y hace contrastar la ruta cyan encima.
    // Narrowing por el discriminante `type` para tipar el paint como raster sin usar `any`.
    if (layer?.type !== 'raster') {
      throw new Error('La primera capa debe ser de tipo raster');
    }
    const { paint } = layer;
    expect(paint).toBeDefined();
    // Tile atenuado (no negro puro): max < 1 baja el blanco a gris oscuro.
    expect(paint?.['raster-brightness-max']).toBeLessThan(1);
    expect(paint?.['raster-brightness-min']).toBe(0);
    // Desaturado: el OSM colorido no compite con el cyan de marca.
    expect(paint?.['raster-saturation']).toBeLessThan(0);
    expect(paint?.['raster-contrast']).toBeLessThanOrEqual(0);
  });
});
