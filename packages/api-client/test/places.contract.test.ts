import { describe, expect, it } from 'vitest';
import {
  createSavedPlace,
  savedPlace,
  savedPlaceKind,
  savedPlaceList,
  updateSavedPlace,
} from '../src/mobile.js';

/**
 * Test de contrato: los schemas de Lugares guardados deben parsear EXACTAMENTE lo que devuelve el
 * public-bff (`PlaceView`: coordenadas planas lat/lng, `subtitle` nullable, `createdAt`/`updatedAt`).
 * Si el BFF cambia la forma, este test rompe antes que la app en runtime.
 */
describe('savedPlace contract', () => {
  it('parsea la respuesta REAL del BFF de un favorito con subtitle', () => {
    const fromBff = {
      id: 'p1',
      kind: 'FAVORITE',
      label: 'Gimnasio',
      subtitle: 'Av. Larco 123, Miraflores',
      lat: -12.121,
      lng: -77.029,
      createdAt: '2026-05-30T00:00:00.000Z',
      updatedAt: '2026-05-30T00:00:00.000Z',
    };
    expect(savedPlace.parse(fromBff)).toEqual(fromBff);
  });

  it('acepta subtitle: null (el BFF normaliza el subtítulo vacío a null)', () => {
    const home = {
      id: 'p2',
      kind: 'HOME',
      label: 'Casa',
      subtitle: null,
      lat: -12.04,
      lng: -77.04,
      createdAt: '2026-05-30T00:00:01.000Z',
      updatedAt: '2026-05-30T00:00:01.000Z',
    };
    const parsed = savedPlace.parse(home);
    expect(parsed.subtitle).toBeNull();
    expect(parsed.kind).toBe('HOME');
  });

  it('tolera respuestas sin updatedAt (campo opcional)', () => {
    const parsed = savedPlace.parse({
      id: 'p3',
      kind: 'WORK',
      label: 'Trabajo',
      subtitle: null,
      lat: -12.05,
      lng: -77.05,
      createdAt: '2026-05-30T00:00:02.000Z',
    });
    expect(parsed.updatedAt).toBeUndefined();
  });

  it('parsea la lista ordenada del GET /places', () => {
    const list = savedPlaceList.parse([
      {
        id: 'p2',
        kind: 'HOME',
        label: 'Casa',
        subtitle: null,
        lat: -12.04,
        lng: -77.04,
        createdAt: '2026-05-30T00:00:01.000Z',
      },
      {
        id: 'p1',
        kind: 'FAVORITE',
        label: 'Gimnasio',
        subtitle: 'Av. Larco 123',
        lat: -12.121,
        lng: -77.029,
        createdAt: '2026-05-30T00:00:00.000Z',
      },
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]?.kind).toBe('HOME');
  });

  it('rechaza un kind inválido', () => {
    expect(() => savedPlaceKind.parse('OTHER')).toThrow();
  });

  it('valida el body de creación (label 1..40) y el de actualización (misma forma)', () => {
    const body = { kind: 'FAVORITE', label: 'Casa de mamá', lat: -12.04, lng: -77.04 };
    expect(createSavedPlace.parse(body)).toEqual(body);
    expect(updateSavedPlace.parse(body)).toEqual(body);
    expect(() => createSavedPlace.parse({ ...body, label: '' })).toThrow();
  });
});
