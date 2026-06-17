import type { GeoPoint, MobilePaymentMethod, QuoteOption } from '@veo/api-client';
import { buildCreateTripInput } from './buildCreateTripInput';

const ORIGIN: GeoPoint = { lat: -12.0464, lon: -77.0428 };
const DESTINATION: GeoPoint = { lat: -12.1027, lon: -77.0345 };
const PAYMENT: MobilePaymentMethod = 'CASH';

function option(over: Partial<QuoteOption> = {}): QuoteOption {
  return {
    id: 'veo_moto',
    name: 'VEO Moto',
    vehicleType: 'MOTO',
    etaSeconds: 600,
    priceCents: 1760,
    currency: 'PEN',
    ...over,
  } as QuoteOption;
}

const base = {
  origin: ORIGIN,
  destination: DESTINATION,
  paymentMethod: PAYMENT,
  bidCents: null as number | null,
  specialRequests: [] as never[],
  waypoints: [] as GeoPoint[],
  scheduledAt: null as number | null,
  promoCode: null as string | null,
  childMode: { enabled: false, code: '' },
};

describe('buildCreateTripInput', () => {
  it('PUJA · manda category + vehicleType (habilita pujar una Moto) + bidCents', () => {
    const out = buildCreateTripInput({
      ...base,
      selectedId: 'veo_moto',
      selectedOption: option({ id: 'veo_moto', vehicleType: 'MOTO' }),
      selectedIsPuja: true,
      bidCents: 1800,
    });
    // El fix de A3b: en PUJA el vehicleType VIAJA → el board filtra el pool y la puja va a Motos.
    expect(out.category).toBe('veo_moto');
    expect(out.vehicleType).toBe('MOTO');
    expect(out.bidCents).toBe(1800);
  });

  it('FIXED · manda category + vehicleType, SIN bidCents aunque haya un bid stale', () => {
    const out = buildCreateTripInput({
      ...base,
      selectedId: 'veo_economico',
      selectedOption: option({ id: 'veo_economico', vehicleType: 'CAR' }),
      selectedIsPuja: false,
      bidCents: 9999, // presente en estado pero NO debe viajar en FIJO
    });
    expect(out.category).toBe('veo_economico');
    expect(out.vehicleType).toBe('CAR');
    expect(out.bidCents).toBeUndefined();
  });

  it('specialRequests SOLO viajan en PUJA', () => {
    const puja = buildCreateTripInput({
      ...base,
      selectedId: 'veo_moto',
      selectedOption: option(),
      selectedIsPuja: true,
      bidCents: 1800,
      specialRequests: ['PET'] as never[],
    });
    expect(puja.specialRequests).toEqual(['PET']);

    const fixed = buildCreateTripInput({
      ...base,
      selectedId: 'veo_economico',
      selectedOption: option({ vehicleType: 'CAR' }),
      selectedIsPuja: false,
      specialRequests: ['PET'] as never[],
    });
    expect(fixed.specialRequests).toBeUndefined();
  });

  it('campos transversales: waypoints, scheduledFor, promoCode, childMode', () => {
    const out = buildCreateTripInput({
      ...base,
      selectedId: 'veo_moto',
      selectedOption: option(),
      selectedIsPuja: true,
      bidCents: 1800,
      waypoints: [{ lat: -12.07, lon: -77.04 }],
      scheduledAt: 1_900_000_000_000,
      promoCode: 'VEO10',
      childMode: { enabled: true, code: '1234' },
    });
    expect(out.waypoints).toHaveLength(1);
    expect(typeof out.scheduledFor).toBe('string');
    expect(out.promoCode).toBe('VEO10');
    expect(out.childMode).toBe(true);
    expect(out.childCode).toBe('1234');
  });
});
