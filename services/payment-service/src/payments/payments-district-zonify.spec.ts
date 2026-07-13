/**
 * MÉTRICAS · "Ingresos por distrito" — la captura del cobro (`chargeFromTripCompleted`, la entrada que
 * dispara el consumer trip.completed) ZONIFICA el origen del viaje (originLat/originLng threadeados desde el
 * evento) a un distrito de Lima y lo persiste DENORMALIZADO en `Payment.district`. Ese es el seam que hace
 * poblar el panel admin. Degradación HONESTA: sin coordenadas (evento legacy N-2) o fuera de cobertura →
 * `district` null (no se inventa un distrito). Cubrimos: coords en cobertura → distrito; coords ausentes →
 * null; coords fuera del radio → null.
 */
import { describe, it, expect, vi } from 'vitest';
import { PaymentsService } from './payments.service';

type Row = Record<string, unknown>;

/** Captura el `data` del createPayment y lo devuelve como la fila creada (status PENDING). */
function buildService() {
  const created: Row[] = [];
  const repo = {
    findPaymentByDedupKey: vi.fn(async () => null), // primer cobro (no idempotente-hit)
    createPayment: vi.fn(async (data: Row) => {
      created.push(data);
      return { ...data };
    }),
  };
  // CASH no toca el gateway (captura por confirmación bilateral, BR-P03) → el resto del ctor lee números
  // que no afectan este camino. Pasamos el método CASH explícito para NO arrancar el riel digital.
  const config = { getOrThrow: () => 0 };
  const service = new PaymentsService(
    repo as never,
    {} as never, // gateway: CASH no lo toca
    {} as never, // affiliations
    {} as never, // promotions (sin promoCode)
    config as never,
  );
  return { service, created };
}

// Centroide REAL de Miraflores en zonify.ts (asignación por centroide más cercano; distancia 0 → match seguro).
const MIRAFLORES = { lat: -12.121, lng: -77.03 };

describe('captura · zonificación del origen → Payment.district (corte por distrito del panel)', () => {
  it('CON coordenadas en cobertura → district = distrito zonificado (Miraflores) + origen persistido', async () => {
    const { service, created } = buildService();
    await service.chargeFromTripCompleted({
      tripId: '00000000-0000-0000-0000-000000000001',
      grossCents: 1500,
      dedupKey: 'trip-charge:trip-1',
      method: 'CASH',
      originLat: MIRAFLORES.lat,
      originLng: MIRAFLORES.lng,
    });
    expect(created).toHaveLength(1);
    const p = created[0]!;
    expect(p.originLat).toBe(MIRAFLORES.lat);
    expect(p.originLng).toBe(MIRAFLORES.lng);
    expect(p.district).toBe('Miraflores'); // el seam completo: evento → capture input → zonifyLima → columna
  });

  it('SIN coordenadas (evento legacy N-2) → district null (degradación honesta, no se inventa distrito)', async () => {
    const { service, created } = buildService();
    await service.chargeFromTripCompleted({
      tripId: '00000000-0000-0000-0000-000000000002',
      grossCents: 1500,
      dedupKey: 'trip-charge:trip-2',
      method: 'CASH',
      // sin originLat/originLng (evento viejo emitido antes del seam)
    });
    const p = created[0]!;
    expect(p.originLat).toBeNull();
    expect(p.originLng).toBeNull();
    expect(p.district).toBeNull();
  });

  it('coordenadas FUERA de cobertura (mar afuera 0,0) → district null (no se asigna un distrito lejano)', async () => {
    const { service, created } = buildService();
    await service.chargeFromTripCompleted({
      tripId: '00000000-0000-0000-0000-000000000003',
      grossCents: 1500,
      dedupKey: 'trip-charge:trip-3',
      method: 'CASH',
      originLat: 0,
      originLng: 0,
    });
    expect(created[0]!.district).toBeNull();
  });
});
