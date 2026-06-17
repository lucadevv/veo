import type {OfferMadeMsg, OfferView} from '@veo/api-client';
import {mergeOffers} from '../src/features/trip/domain/offers';

function view(
  driverId: string,
  priceCents: number,
  kind: OfferView['kind'],
  etaSeconds = 240,
): OfferView {
  return {
    tripId: 't1',
    driverId,
    kind,
    priceCents,
    etaSeconds,
    status: 'PENDING',
  };
}
function live(
  driverId: string,
  priceCents: number,
  kind: OfferMadeMsg['kind'],
  etaSeconds = 240,
): OfferMadeMsg {
  return {
    tripId: 't1',
    driverId,
    kind,
    priceCents,
    etaSeconds,
    at: '2026-06-05T10:00:00.000Z',
  };
}

/**
 * El board del pasajero mezcla el snapshot REST con lo que entra por socket. Dos invariantes: (1) una
 * sola tarjeta por conductor (la EN VIVO pisa, es más fresca), (2) orden que ayuda a elegir: acepta-precio
 * primero, luego más barato, luego ETA. Si esto falla, el pasajero ve ofertas duplicadas o desordenadas.
 */
describe('puja · mergeOffers', () => {
  it('sin ofertas → lista vacía', () => {
    expect(mergeOffers([], [])).toEqual([]);
  });

  it('una oferta EN VIVO pisa la del mismo conductor en el REST', () => {
    const rest = [view('drv-1', 1300, 'COUNTER')];
    const merged = mergeOffers(rest, [live('drv-1', 1500, 'COUNTER')]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.priceCents).toBe(1500); // la versión en vivo
  });

  it('combina conductores distintos de REST y socket', () => {
    const merged = mergeOffers(
      [view('drv-1', 1300, 'ACCEPT_PRICE')],
      [live('drv-2', 1400, 'COUNTER')],
    );
    expect(merged.map(o => o.driverId).sort()).toEqual(['drv-1', 'drv-2']);
  });

  it('BE-1 · el live (sin enriquecer) preserva nombre/rating/vehículo del REST (no parpadea)', () => {
    const restEnriched: OfferView = {
      tripId: 't1',
      driverId: 'drv-1',
      kind: 'ACCEPT_PRICE',
      priceCents: 1300,
      etaSeconds: 240,
      status: 'PENDING',
      driverName: 'Khalid Ríos',
      rating: 4.9,
      ratingCount: 10,
      vehicle: {
        make: 'Toyota',
        model: 'Yaris',
        color: 'Plomo',
        plate: 'ABC-481',
      },
    };
    // El MISMO conductor manda un offer:made fresco (COUNTER a otro precio), SIN enriquecer.
    const merged = mergeOffers(
      [restEnriched],
      [live('drv-1', 1600, 'COUNTER')],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.priceCents).toBe(1600); // el live gana en precio/kind (es más fresco)
    expect(merged[0]!.kind).toBe('COUNTER');
    expect(merged[0]!.driverName).toBe('Khalid Ríos'); // pero preserva el enriquecimiento del REST
    expect(merged[0]!.rating).toBe(4.9);
    expect(merged[0]!.vehicle?.make).toBe('Toyota');
  });

  it('BE-3 · excluye los driverIds RETIRADOS (offer:withdrawn) de ambas fuentes', () => {
    const merged = mergeOffers(
      [view('drv-1', 1300, 'ACCEPT_PRICE'), view('drv-2', 1400, 'COUNTER')],
      [live('drv-3', 1500, 'COUNTER')],
      ['drv-1', 'drv-3'], // retirados: uno del REST, uno del socket
    );
    expect(merged.map(o => o.driverId)).toEqual(['drv-2']);
  });

  it('ordena: acepta-precio primero, luego por precio, luego por ETA', () => {
    const merged = mergeOffers(
      [
        view('counter-caro', 1600, 'COUNTER', 120),
        view('acepta-b', 1300, 'ACCEPT_PRICE', 300),
        view('acepta-a', 1300, 'ACCEPT_PRICE', 180),
        view('counter-barato', 1400, 'COUNTER', 240),
      ],
      [],
    );
    expect(merged.map(o => o.driverId)).toEqual([
      'acepta-a', // ACCEPT_PRICE, 1300, eta 180
      'acepta-b', // ACCEPT_PRICE, 1300, eta 300
      'counter-barato', // COUNTER, 1400
      'counter-caro', // COUNTER, 1600
    ]);
  });
});
