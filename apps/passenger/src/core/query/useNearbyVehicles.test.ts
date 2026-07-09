import {quantizeCoord} from './useNearbyVehicles';

describe('quantizeCoord · estabilidad del queryKey del polling de ambiente', () => {
  it('redondea a 3 decimales (~111m)', () => {
    expect(quantizeCoord(-12.003267)).toBe(-12.003);
    expect(quantizeCoord(-77.063354)).toBe(-77.063);
  });

  it('mapea dos fixes con drift sub-100m a la MISMA clave (no re-fetch)', () => {
    // ~5m de drift entre fixes: mismo valor cuantizado → mismo queryKey → un solo fetch.
    const a = quantizeCoord(-12.00331);
    const b = quantizeCoord(-12.00329);
    expect(a).toBe(b);
  });

  it('mapea fixes en celdas distintas a claves distintas (sí re-fetch al cruzar de celda)', () => {
    const a = quantizeCoord(-12.0035);
    const b = quantizeCoord(-12.0045);
    expect(a).not.toBe(b);
  });
});
