import type { TripActiveView, TripResource } from '@veo/api-client';
import { buildReceipt, formatReceiptText } from '../src/features/trip/domain/receipt';

const view: TripActiveView = {
  id: 't-1',
  status: 'COMPLETED',
  passengerId: 'pax',
  fareCents: 2300, // total (incluye propina)
  currency: 'PEN',
  tipCents: 500,
  distanceMeters: 5200,
  durationSeconds: 720,
  paymentMethod: 'YAPE',
  childMode: false,
  penaltyCents: 0,
  driver: {
    id: 'd-1',
    status: 'ACTIVE',
    backgroundCheckStatus: 'APPROVED',
    rating: 4.8,
    ratingCount: 120,
  },
  vehicle: {
    id: 'v-1',
    plate: 'ABC-123',
    make: 'Toyota',
    model: 'Yaris',
    year: 2021,
    color: 'Plata',
  },
};

const snapshot: TripResource = {
  id: 't-1',
  passengerId: 'pax',
  driverId: 'd-1',
  vehicleId: 'v-1',
  status: 'COMPLETED',
  origin: { lat: -12.04, lon: -77.04 },
  destination: { lat: -12.1, lon: -77.0 },
  fareCents: 2300,
  currency: 'PEN',
  surgeMultiplier: 1.3,
  distanceMeters: 5200,
  durationSeconds: 720,
  paymentMethod: 'YAPE',
  routePolyline: null,
  childMode: false,
  penaltyCents: 0,
  requestedAt: '2026-05-29T15:04:00.000Z',
  completedAt: '2026-05-29T15:20:00.000Z',
  cancelledAt: null,
};

const labels = {
  title: 'Recibo VEO',
  baseFare: 'Tarifa base',
  surge: (m: number) => `Demanda alta (x${m})`,
  tip: 'Propina',
  total: 'Total',
  paymentMethod: 'Método de pago',
  date: 'Fecha',
  driver: 'Conductor',
  vehicle: 'Vehículo',
  route: 'Recorrido',
  distance: 'Distancia',
  duration: 'Duración',
  durationMinutes: (min: number) => `${min} min`,
};

describe('buildReceipt', () => {
  it('deriva la tarifa base como total − propina', () => {
    const receipt = buildReceipt(view, snapshot);
    expect(receipt.totalCents).toBe(2300);
    expect(receipt.tipCents).toBe(500);
    expect(receipt.baseFareCents).toBe(1800);
  });

  it('expone surge solo cuando el multiplicador es > 1', () => {
    expect(buildReceipt(view, snapshot).surgeMultiplier).toBe(1.3);
    expect(buildReceipt(view, { ...snapshot, surgeMultiplier: 1 }).surgeMultiplier).toBeUndefined();
  });

  it('omite con gracia los datos del snapshot cuando no hay snapshot', () => {
    const receipt = buildReceipt(view, null);
    expect(receipt.date).toBeUndefined();
    expect(receipt.originLabel).toBeUndefined();
    expect(receipt.surgeMultiplier).toBeUndefined();
    // El view sí aporta conductor/vehículo.
    expect(receipt.vehicleLabel).toContain('Toyota');
  });
});

describe('formatReceiptText', () => {
  it('arma un texto con desglole completo, sin líneas "undefined"', () => {
    const text = formatReceiptText(buildReceipt(view, snapshot), labels);
    expect(text).toContain('Recibo VEO');
    expect(text).toContain('Tarifa base: S/ 18.00');
    expect(text).toContain('Propina: S/ 5.00');
    expect(text).toContain('Total: S/ 23.00');
    expect(text).toContain('Demanda alta (x1.3)');
    expect(text).toContain('12 min');
    expect(text).not.toContain('undefined');
  });

  it('omite la propina cuando es 0', () => {
    const text = formatReceiptText(buildReceipt({ ...view, tipCents: 0 }, snapshot), labels);
    expect(text).not.toContain('Propina:');
    expect(text).toContain('Total: S/ 23.00');
  });
});
