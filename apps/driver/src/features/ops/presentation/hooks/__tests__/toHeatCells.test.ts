import { toHeatCells } from '../useHeatCells';
import type { DemandHeatmap } from '../../../domain';

/**
 * Regresión del crash del dashboard: el mapeo de celdas de demanda NUNCA debe reventar por datos
 * faltantes o fuera de contrato. Antes, `heatmap.cells.map` lanzaba con `heatmap` sin `cells`.
 */
describe('toHeatCells (defensa del dashboard)', () => {
  it('devuelve [] cuando el heatmap es undefined (React Query antes de cargar)', () => {
    expect(toHeatCells(undefined)).toEqual([]);
  });

  it('devuelve [] cuando el heatmap es null', () => {
    expect(toHeatCells(null)).toEqual([]);
  });

  it('devuelve [] cuando `cells` falta o no es un array (forma inesperada del servicio)', () => {
    expect(
      toHeatCells({ generatedAt: '2026-05-30T00:00:00Z' } as unknown as DemandHeatmap),
    ).toEqual([]);
    expect(
      toHeatCells({ cells: null, generatedAt: '2026-05-30T00:00:00Z' } as unknown as DemandHeatmap),
    ).toEqual([]);
  });

  it('devuelve [] cuando la lista de celdas está vacía', () => {
    expect(toHeatCells({ cells: [], generatedAt: '2026-05-30T00:00:00Z' })).toEqual([]);
  });

  it('descarta celdas con centroides no finitos (NaN/incompletos) sin reventar', () => {
    const heatmap = {
      generatedAt: '2026-05-30T00:00:00Z',
      cells: [
        { h3: 'ok', centroidLat: -12.05, centroidLng: -77.04, intensity: 0.5 },
        // Celdas corruptas que producirían un GeoJSON inválido:
        { h3: 'nan', centroidLat: Number.NaN, centroidLng: -77.0, intensity: 0.9 },
        { h3: 'missing', intensity: 0.2 },
        null,
      ],
    } as unknown as DemandHeatmap;

    const cells = toHeatCells(heatmap);
    expect(cells).toHaveLength(1);
    const [cell] = cells;
    expect(cell).toBeDefined();
    expect(cell?.id).toBe('ok');
    expect(cell?.coordinate).toEqual([-77.04, -12.05]);
    expect(cell?.opacity).toBeGreaterThan(0);
    expect(cell?.radiusMeters).toBeGreaterThan(0);
  });

  it('mapea correctamente una celda válida a [lng, lat]', () => {
    const cells = toHeatCells({
      generatedAt: '2026-05-30T00:00:00Z',
      cells: [{ h3: 'a', centroidLat: -12.0, centroidLng: -77.0, intensity: 1 }],
    });
    expect(cells[0]?.coordinate).toEqual([-77.0, -12.0]);
  });
});
