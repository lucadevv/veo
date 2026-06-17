import {
  formatDistance,
  formatDurationMinutes,
  formatPEN,
  formatShortDate,
} from '../src/shared/utils/format';
import {decodePolyline} from '../src/shared/utils/polyline';
import {uuidv4} from '../src/shared/utils/uuid';

describe('format', () => {
  it('formatea céntimos PEN a soles', () => {
    expect(formatPEN(1500)).toBe('S/ 15.00');
    expect(formatPEN(0)).toBe('S/ 0.00');
    expect(formatPEN(1234567)).toBe('S/ 12,345.67');
  });

  it('formatea distancia en metros/km', () => {
    expect(formatDistance(850)).toBe('850 m');
    expect(formatDistance(4200)).toBe('4.2 km');
  });

  it('convierte segundos a minutos (mínimo 1)', () => {
    expect(formatDurationMinutes(540)).toBe(9);
    expect(formatDurationMinutes(10)).toBe(1);
  });

  it('formatea fecha corta es-PE', () => {
    expect(formatShortDate('2026-05-29T10:00:00.000Z')).toMatch(
      /\d{2}\/\d{2}\/2026/,
    );
  });
});

describe('uuidv4', () => {
  it('genera un UUID v4 válido', () => {
    expect(uuidv4()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('decodePolyline', () => {
  it('devuelve [] para entrada vacía/nula', () => {
    expect(decodePolyline(null)).toEqual([]);
    expect(decodePolyline('')).toEqual([]);
  });

  it('decodifica una polyline conocida de Google', () => {
    // Ejemplo canónico de la documentación de Google: "_p~iF~ps|U_ulLnnqC_mqNvxq`@".
    const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(points).toHaveLength(3);
    expect(points[0]!.latitude).toBeCloseTo(38.5, 1);
    expect(points[0]!.longitude).toBeCloseTo(-120.2, 1);
  });
});
